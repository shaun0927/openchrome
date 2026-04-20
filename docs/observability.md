# Observability: tenant + request correlation

Issue #10 (B-4) adds tenant-aware metric labels, request correlation IDs, and
an extended audit log schema so operators can answer "who ran what, when, and
how long did it take?" per tenant in a multi-tenant SaaS deployment.

This document describes the schemas, the rollback flags, and the propagation
rules every OpenChrome operator needs to know.

## 1. Request correlation ID

Every inbound MCP request carries a correlation ID via the `X-Request-Id`
header.

- **Client supplies a header**: the server honours it if it matches
  `^[A-Za-z0-9._:-]+$` and is ≤ 128 characters. Invalid values are ignored.
- **No header**: the server mints a UUID v7 (48-bit ms timestamp + random —
  lexicographically sortable).
- **Response echo**: the resolved ID is always echoed in the `X-Request-Id`
  response header, and is exposed through CORS.
- **Internal propagation**: the ID flows through `AsyncLocalStorage` so audit
  entries, metrics, and logger calls can pick it up without plumbing.

The correlation ID appears in:

- `X-Request-Id` response header
- `[req=<id>]` prefix on `log.error()` / `log.warn()` / `log.info()` lines
- Audit log `requestId` field
- Future (B-4 follow-up): Prometheus `request_id` exemplars

Client example:

```bash
curl -H "X-Request-Id: my-trace-abc" -X POST http://localhost:3000/mcp -d '...'
# → response header: X-Request-Id: my-trace-abc
# → audit.log line: {"requestId":"my-trace-abc",...}
```

## 2. Tenant-aware metric labels

Core metrics carry a `tenant` label:

| Metric                                        | Labels                           |
| --------------------------------------------- | -------------------------------- |
| `openchrome_tool_calls_total`                 | `tool`, `status`, `tenant`       |
| `openchrome_tool_duration_seconds`            | `tool`, `tenant`                 |
| `openchrome_rate_limit_rejections_total`      | `tool`, `tenant`                 |

### Cardinality guard

A malformed tenant identifier must not blow up Prometheus storage. The
`normaliseTenantLabel` helper enforces:

- Non-string input → `tenant="unknown"`
- Strip any character outside `[A-Za-z0-9_]`
- Truncate to 64 characters
- Empty after strip → `tenant="unknown"`

### Tenant source

`withTenantLabel(labels, tenantId?)` attaches the label. It reads the tenant
from, in priority order:

1. The explicit `tenantId` argument
2. The active `RequestContext.tenantId` (set by auth / transport layers)
3. Falls back to `"unknown"` (current default until B-1 / B-3 land)

## 3. Extended audit log schema

Audit entries become:

```json
{
  "ts": "2026-04-18T09:30:00.123Z",
  "requestId": "0193abc-...",
  "tenantId": "t_acme",
  "keyId": null,
  "sessionId": "sess_xyz",
  "tool": "navigate",
  "domain": "example.com",
  "status": "success",
  "durationMs": 342,
  "aborted": false,
  "billable": true,
  "argsHash": "sha256:...",
  "args": { "url": "https://example.com" }
}
```

- `argsHash` is sha256 of the canonicalised original args (integrity anchor).
- `args` is the redacted view — see §4.
- `billable` defaults to `true` unless `status === "error"`.
- Error entries additionally carry `errorMessage`.

## 4. Args redaction rules

`config/audit-redaction.json` defines per-tool rules. Modes:

| Mode                      | Behaviour                                                |
| ------------------------- | -------------------------------------------------------- |
| `redact`                  | Replace value with `[REDACTED]`                          |
| `hash`                    | Replace value with `sha256:<hex>` of its JSON string     |
| `truncate`                | Keep first `maxBytes`, append hash of full value         |
| `redactIfSensitiveName`   | Redact when the field name (or sibling `name`) looks sensitive |

A second-pass heuristic redacts any field whose **name** looks sensitive
(`password`, `token`, `authorization`, `cookie`, …) anywhere in the args tree,
so a missing rule never leaks a password.

Override the config path with `OPENCHROME_AUDIT_REDACTION_CONFIG=/path/to.json`.

## 5. Rollback flags

| Flag                            | Effect                                                       |
| ------------------------------- | ------------------------------------------------------------ |
| `OPENCHROME_TENANT_METRICS=false` | Metrics omit the `tenant` label (pre-B-4 shape).           |
| `OPENCHROME_AUDIT_EXTENDED=false` | Audit log reverts to `{timestamp, tool, domain, sessionId, args_summary}`. |
| `OPENCHROME_AUDIT_REDACTION_CONFIG` | Override the redaction rules file path.                  |

Rollback triggers (from issue #10):

- Prometheus storage usage > 10× pre-B-4 baseline → disable tenant labels.
- Audit write latency > 10% of tool p99 latency → disable extended audit.

## 6. Dependencies & follow-ups

- **Depends on**: B-1 (tenant isolation) and B-3 (per-tenant auth) to populate
  `RequestContext.tenantId` with real values. Until then the label is
  `unknown`.
- **Follow-ups**: billing integration (`openchrome_tool_calls_total{tenant}`
  monthly rollup), per-tenant error-rate SLO alerts, audit log DB sink
  (file → Postgres), GDPR erasure tool.
