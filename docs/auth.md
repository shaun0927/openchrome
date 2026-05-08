# Authentication

OpenChrome supports five auth modes. The mode is selected by environment variable or programmatic options when constructing an `HTTPTransport`.

---

## Overview

| Mode | Env value | Description |
|---|---|---|
| `disabled` | `disabled` | No token required. All requests get admin scopes. Development only. |
| `legacy-shared-token` | `legacy-shared-token` | Single shared bearer token. Backward compatible with pre-v1.9 deployments. |
| `api-key` | `api-key` | Per-tenant API keys stored in `~/.openchrome/auth/api-keys.jsonl`. |
| `jwt` | `jwt` | Short-lived JWTs verified via a remote JWKS endpoint (OAuth/OIDC). |
| `api-key-or-jwt` | `api-key-or-jwt` | Accepts either. Tokens prefixed `oc_live_` are routed to the key store; everything else is verified as a JWT. |

Set the mode:

```bash
export OPENCHROME_AUTH_MODE=api-key
```

---

## Quickstart: API keys

### 1. Set the admin token

The admin CLI requires a shared secret to authorize key management operations.

```bash
export OPENCHROME_ADMIN_TOKEN=<your-secret>
```

Store this only on the server. It never leaves the machine.

### 2. Create a key

```bash
openchrome admin keys create --tenant t1 --scope write --description "prod worker"
```

Example output:

```
oc_live_t1_X3rQ8mN2zJ...   ← stdout: shown ONCE
[stderr] SAVE THIS KEY NOW. It will not be shown again.
[stderr] keyId: k_A7bCdEfGhI
```

The `oc_live_...` plaintext is printed **once** to stdout. Copy it immediately; it cannot be recovered. The `keyId` is a non-secret identifier derived from the key — safe to log and reference in support tickets.

### 3. Send requests

```bash
curl -H "Authorization: Bearer oc_live_t1_X3rQ8mN2zJ..." \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
     http://localhost:3000/mcp
```

---

## Scopes

Each key is issued with one or more scopes. Scopes are additive; `write` implies `read`.

| Scope | Allows |
|---|---|
| `read` | `screenshot`, `read_page`, `query_dom`, `inspect`, `find`, `wait_for`, `tabs_context`, and all other non-mutating tools |
| `write` | All of `read`, plus: `act`, `interact`, `click`, `type`, `press`, `scroll`, `drag_drop`, `lightweight_scroll`, `fill_form`, `form_input`, `file_upload`, `select_option`, `navigate`, `page_reload`, `tabs_create`, `tabs_close`, `javascript_tool`, `cookies`, `storage`, `http_auth`, `network`, `request_intercept`, `emulate_device`, `user_agent`, `geolocation`, `oc_stop`, `oc_session_resume`, `oc_session_snapshot`, `oc_checkpoint`, `workflow_init`, `workflow_cleanup`, `worker_update`, `worker_complete`, `execute_plan`, `oc_recording_start`, `oc_recording_stop`, `computer`, `batch_execute`, `batch_paginate`, `crawl`, `crawl_sitemap` |
| `admin` | All tools. Reserved for server-internal tools; currently no tools require `admin` scope exclusively. |
| `headless-only` | Additional constraint (AND-combined with the key's other scopes): the tool call is only permitted when the server is running in headless mode. |

Scope implication chain: `admin` > `write` > `read`. `headless-only` is orthogonal and enforced separately by the caller.

### Dashboard REST endpoints

Dashboard REST endpoints use the same trusted HTTP principal as `/mcp`; clients cannot supply scope or tenant identity in JSON bodies or query parameters. Missing or invalid bearer auth returns `401`; authenticated callers without the required endpoint scope, or callers requesting another tenant's session, receive `403`.

| Endpoint | Required scope | Tenant/session rule |
|---|---|---|
| `GET /api/screenshot` | `read` | When `session_id` or `sessionId` is supplied, the session must belong to the caller's tenant. |
| `GET /api/sessions` | `read` | API-key/JWT callers receive only sessions owned by their tenant. |
| `GET /api/tool-calls` | `admin` | Admin-only because tool-call records can include sensitive arguments. |
| `GET /api/metrics` | `admin` | Admin-only while the endpoint exposes global process/server counters. |


---

## Key rotation

Rotate a key when it may be compromised or as part of regular key hygiene:

```bash
openchrome admin keys rotate <keyId>
```

Rotation is an immediate revoke-and-reissue operation: the old key is marked
revoked before the replacement key is returned. Plan cutovers so clients can
switch promptly after you run the command.

Recommended rotation procedure:

1. Run `openchrome admin keys rotate <keyId>`. Note the new `oc_live_...` key and its `keyId`.
2. Immediately deploy the new key to all clients (requests using the old key now receive `401 Unauthorized`).
3. Verify traffic has switched over by checking `lastUsedAt` in `openchrome admin keys list --json`.

Revocation propagates to in-flight requests within one token-bucket refresh cycle (< 1 second); no server restart is required.

---

## Revocation

```bash
openchrome admin keys revoke <keyId>
```

The key is marked `revokedAt` in the JSONL store. The in-memory index is updated atomically. The next request using the revoked key receives a `401 Unauthorized` response. No restart is needed.

Revocation is idempotent — revoking an already-revoked key is a no-op.

---

## JWT / OAuth setup

Pass JWT config through `HTTPTransportOptions.jwt` when constructing an `HTTPTransport` programmatically:

```ts
import { HTTPTransport } from './src/transports/http';

const transport = new HTTPTransport(3000, '0.0.0.0', undefined, {
  jwt: {
    jwksUrl:     'https://auth.example.com/.well-known/jwks.json',
    issuer:      'https://auth.example.com/',
    audience:    'openchrome',
    tenantClaim: 'tenantId',   // JWT claim that carries the tenant id; defaults to 'tenantId'
    scopeClaim:  'scope',      // JWT claim that carries scopes; defaults to 'scope'
  },
});
transport.start();
```

The `tenantClaim` field in the JWT must contain a non-empty string. The `scopeClaim` must contain either a space-separated string or an array of strings matching the valid scope names (`read`, `write`, `admin`, `headless-only`). Any token where either field is absent or invalid is rejected with 401.

---

## Rollback

To revert to the previous single-token behaviour:

```bash
export OPENCHROME_AUTH_MODE=legacy-shared-token
export OPENCHROME_AUTH_TOKEN=<shared-token>
```

The JSONL key store at `~/.openchrome/auth/api-keys.jsonl` is preserved and reactivated automatically when you switch back to `api-key` mode. No data is lost.

---

## Security notes

- **Hashing**: API key plaintexts are hashed with argon2id (memoryCost=19 MiB, timeCost=2, parallelism=1) before storage. The plaintext is never written to disk.
- **Constant-time verification**: `store.verify()` always performs one `argon2.verify` call regardless of whether the key exists. Unknown keys are verified against an in-memory decoy hash generated at startup to prevent timing-based key enumeration.
- **Plaintext visibility**: The raw `oc_live_...` key is returned exactly once — from `create()` or `rotate()`. The audit logger scrubs any `oc_live_*` substring appearing in tool arguments before writing to the audit log (defense-in-depth; the store never emits plaintexts).
- **keyId safety**: The `keyId` (`k_<10-char base62>`) is derived from the first 10 characters of `base62(sha256(plaintext))`. It is a non-secret opaque reference — safe to include in logs, support tickets, and audit entries. It cannot be reversed to obtain the plaintext.
- **File permissions**: The JSONL store is created with mode `0600`; its parent directory with mode `0700` (POSIX only; Windows skips `chmod`). These are enforced on every `ApiKeyStore.open()` call, not just first creation.

---

## Troubleshooting

**`401 Unauthorized` — no `Authorization` header sent**

All modes except `disabled` require a `Bearer` token. Check that your client sends:

```
Authorization: Bearer oc_live_...
```

**`401 Unauthorized` — `OPENCHROME_ADMIN_TOKEN` not set**

The admin CLI checks for this env var before opening the store. Set it and retry:

```bash
export OPENCHROME_ADMIN_TOKEN=<your-secret>
openchrome admin keys create --tenant t1 --scope read
```

**`401 Unauthorized` — correct key, wrong scope**

Verify the key's scopes with:

```bash
openchrome admin keys list --json | python3 -m json.tool
```

If the key has `read` scope and the tool requires `write`, create a new key with the appropriate scope.

**`401 Unauthorized` — expired key**

Keys with an `expiresAt` timestamp in the past are rejected. Rotate the key to issue a fresh one:

```bash
openchrome admin keys rotate <keyId>
```

**`401 Unauthorized` — JWT signature failure**

Verify that:
- The JWKS URL is reachable from the server.
- The JWT `iss` (issuer) matches the `issuer` option passed to `createJwtVerifier`.
- The JWT `aud` (audience) matches the `audience` option.
- The JWT is signed with RS256.
- The token has not expired (`exp` claim).

Enable verbose logging on your identity provider to inspect the token claims.

**Key store file missing after upgrade**

The store is created at `~/.openchrome/auth/api-keys.jsonl`. If the directory was deleted, `ApiKeyStore.open()` recreates it with the correct permissions on the next request. Previously issued keys are lost; issue new keys with `openchrome admin keys create`.
