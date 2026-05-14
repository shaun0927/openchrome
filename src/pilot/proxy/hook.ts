/**
 * Pilot-tier MCP tool: `oc_proxy_hook` (issue #874, browserbase adoption D).
 *
 * Lets the host declare proxy configuration as data — origin → upstream
 * mapping, optional rotation tag, optional auth credentials — without
 * openchrome itself calling any third-party service. The host (or a sidecar
 * process the host controls) supplies the upstream URL; openchrome only
 * binds it to the right CDP target.
 *
 * Strict invariants (verified by tests in `tests/pilot/`):
 *
 *   I1. No outbound HTTP from openchrome to `upstream` during `apply` or
 *       `status` — binding is CDP-plumbing state only. The tool stores the
 *       caller-supplied rule and returns immediately; the actual
 *       `Network.setRequestInterception` / `Fetch.continueWithAuth`
 *       integration is triggered lazily by the per-tab CDP layer on the
 *       next page request (see `applyRulesToTab`), so the *apply* call
 *       itself never opens a socket to `upstream`.
 *
 *   I2. Rotation does not pick the next upstream. The host calls `rotate`
 *       with the new rules; openchrome only re-binds.
 *
 *   I3. Proxy-auth callbacks (`Fetch.authRequired`) are handled with the
 *       credentials embedded in the rule's `upstream` URL. When the upstream
 *       is missing user:pass and the proxy issues a 407, the auth callback
 *       returns a structured error (`reason: 'missing_proxy_credentials'`)
 *       instead of silently falling through with `provideCredentials: false`.
 *
 *   I4. Pilot-gated: when `--pilot` is unset or `OPENCHROME_PROXY_HOOK` is
 *       not truthy, the tool is absent from `tools/list`. v1.11 behaviour is
 *       byte-identical (P2).
 *
 *   I5. Bundling a managed proxy provider is a P3 violation; this module
 *       never calls fetch/http(s).request/net.connect to the upstream.
 *
 * Out of scope (per issue):
 *   - Captcha-solver hook (dropped in r2).
 *   - Built-in proxy provider integrations.
 *   - Automatic rotation (host owns rotation).
 *   - Per-request proxy (per-tab is the granularity).
 */

import { MCPServer } from '../../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../../types/mcp';
import { TOOL_ANNOTATIONS } from '../../types/tool-annotations';
import { isProxyHookEnabled } from '../../harness/flags';

// ---------------------------------------------------------------------------
// Public types (mirror the issue's Contract section exactly).
// ---------------------------------------------------------------------------

export interface ProxyRule {
  /** Glob over the request URL origin. e.g. `*.example.com`, `https://api.*`. */
  originPattern: string;
  /**
   * Upstream proxy URL the host has resolved. openchrome treats the value
   * opaquely; the tool never opens a connection to it. Credentials, if any,
   * are embedded in the URL (`http://user:pass@host:port`).
   */
  upstream: string;
  /** Opaque tag so the host can correlate rotation. */
  ruleTag: string;
}

export type ProxyHookAction = 'apply' | 'clear' | 'status' | 'rotate';

export interface ProxyHookOptions {
  action: ProxyHookAction;
  /** Required for `apply` and `rotate`. */
  rules?: ProxyRule[];
  /** Default: all tabs in the current session. */
  tabId?: string;
}

export interface ProxyBindingReport {
  ruleTag: string;
  bindings: Array<{
    tabId: string;
    origin: string;
    status: 'ok' | 'failed';
    error?: string;
  }>;
}

export interface ProxyHookResponse {
  appliedRules: ProxyBindingReport[];
  capturedAt: number;
}

// ---------------------------------------------------------------------------
// Glob matcher. The grammar is intentionally minimal — `*` matches any run
// of non-`/` characters, anchored against the full origin. Any character that
// could otherwise carry regex meaning is escaped so `example.com.attacker.com`
// does NOT match `*.example.com` (the trailing dot is literal).
// ---------------------------------------------------------------------------

const REGEX_META = /[.+?^${}()|[\]\\]/g;

export function compileOriginGlob(pattern: string): RegExp {
  // Escape regex metacharacters, then translate `*` to `[^/]*`.
  const escaped = pattern.replace(REGEX_META, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

export function matchOrigin(pattern: string, origin: string): boolean {
  return compileOriginGlob(pattern).test(origin);
}

// ---------------------------------------------------------------------------
// Upstream URL parsing — credentials extracted defensively so the auth
// callback can detect "missing credentials" without ever fetching anything.
// ---------------------------------------------------------------------------

export interface ParsedUpstream {
  href: string;
  hostname: string;
  port: number | null;
  username: string;
  password: string;
}

export function parseUpstream(raw: string): ParsedUpstream {
  // URL() handles user:pass@ correctly and percent-decodes the credentials.
  // Any malformed input throws and is caught by the caller.
  const u = new URL(raw);
  return {
    href: u.href,
    hostname: u.hostname,
    port: u.port === '' ? null : Number(u.port),
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
  };
}

export interface ProxyAuthDecision {
  ok: boolean;
  username?: string;
  password?: string;
  reason?: 'missing_proxy_credentials' | 'invalid_upstream';
  error_message?: string;
}

/**
 * Decision logic for `Fetch.authRequired` callbacks. Pure function so the
 * unit test can drive it without a real CDP target. Mirrors the semantics
 * the CDP integration is expected to wire up:
 *
 *   - Credentials present → return them so CDP can `continueWithAuth` with
 *     `provideCredentials`.
 *   - Credentials absent (or the upstream URL is malformed) → return a
 *     structured failure. The CDP integration MUST then cancel the request,
 *     NOT fall through to `provideCredentials: false` (which Chrome treats
 *     as "user pressed cancel" and silently lets the request proceed
 *     unauthenticated — exactly the silent fallthrough invariant I3 forbids).
 */
export function decideProxyAuth(upstream: string): ProxyAuthDecision {
  let parsed: ParsedUpstream;
  try {
    parsed = parseUpstream(upstream);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_upstream',
      error_message: `Upstream URL is not parseable: ${(err as Error).message}`,
    };
  }
  if (parsed.username === '' || parsed.password === '') {
    return {
      ok: false,
      reason: 'missing_proxy_credentials',
      error_message:
        'Upstream issued a 407 but no credentials were embedded in the ' +
        'upstream URL. The host must rewrite the rule with user:pass@host:port. ' +
        'openchrome will not silently retry without credentials.',
    };
  }
  return { ok: true, username: parsed.username, password: parsed.password };
}

// ---------------------------------------------------------------------------
// State container. A single in-memory map of ruleTag → ProxyRule per
// process. The CDP wiring layer reads this on every request interception
// event; the MCP tool only mutates it.
// ---------------------------------------------------------------------------

interface BindingState {
  rule: ProxyRule;
  tabId: string;
  matcher: RegExp;
  appliedAt: number;
}

let bindings: BindingState[] = [];

function snapshotBindings(rules: ProxyRule[], tabId: string): BindingState[] {
  const now = Date.now();
  const next: BindingState[] = [];
  for (const rule of rules) {
    next.push({
      rule,
      tabId,
      matcher: compileOriginGlob(rule.originPattern),
      appliedAt: now,
    });
  }
  return next;
}

/** Test helper — clears the process-wide binding state. */
export function _resetProxyBindingsForTesting(): void {
  bindings = [];
}

/** Diagnostic accessor used by the CDP wiring layer (lazy, no I/O). */
export function getProxyBindingsSnapshot(): ReadonlyArray<BindingState> {
  return bindings.slice();
}

// ---------------------------------------------------------------------------
// MCP surface.
// ---------------------------------------------------------------------------

interface ProxyHookOutput extends Record<string, unknown> {
  ok: boolean;
  reason?: 'disabled' | 'invalid_args';
  applied_rules?: ProxyBindingReport[];
  captured_at?: number;
  error_message?: string;
}

const definition: MCPToolDefinition = {
  name: 'oc_proxy_hook',
  description:
    'Pilot-tier (--pilot + OPENCHROME_PROXY_HOOK=1): bind host-supplied ' +
    "proxy rules (originPattern → upstream) to the current session's CDP " +
    'request interception. openchrome does not contact `upstream`; the host ' +
    'is responsible for the proxy service\'s lifecycle, billing, and ' +
    'rotation. Actions: `apply` (bind rules), `clear` (drop all bindings), ' +
    '`status` (report current bindings), `rotate` (re-bind with new rules; ' +
    'openchrome never picks the next upstream). Missing proxy-auth ' +
    'credentials surface as structured errors rather than silent ' +
    'fallthrough. Default (no flags) behaviour is byte-identical to v1.11.',
  annotations: TOOL_ANNOTATIONS.oc_proxy_hook,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['apply', 'clear', 'status', 'rotate'],
        description:
          'Lifecycle action: `apply` installs `rules`, `rotate` replaces ' +
          'them, `clear` drops all bindings, `status` reports current state.',
      },
      rules: {
        type: 'array',
        description:
          'Required for `apply` and `rotate`. Each rule: ' +
          '{ originPattern, upstream, ruleTag }. originPattern is a glob ' +
          '(`*.example.com`, `https://api.*`). upstream is an opaque URL ' +
          '(`http://user:pass@proxy.example:8080`).',
        items: {
          type: 'object',
          properties: {
            originPattern: { type: 'string' },
            upstream: { type: 'string' },
            ruleTag: { type: 'string' },
          },
          required: ['originPattern', 'upstream', 'ruleTag'],
        },
      },
      tabId: {
        type: 'string',
        description:
          'Optional CDP target id. When omitted, the rules apply to all ' +
          'tabs in the current session (per-tab is the granularity; per-' +
          'request is explicitly out of scope).',
      },
    },
    required: ['action'],
  },
};

function jsonResult<T extends Record<string, unknown>>(payload: T): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...payload,
  };
}

function validateRules(raw: unknown): { ok: true; rules: ProxyRule[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'rules must be an array' };
  }
  const rules: ProxyRule[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, reason: 'each rule must be an object' };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.originPattern !== 'string' || e.originPattern.length === 0) {
      return { ok: false, reason: 'rule.originPattern must be a non-empty string' };
    }
    if (typeof e.upstream !== 'string' || e.upstream.length === 0) {
      return { ok: false, reason: 'rule.upstream must be a non-empty string' };
    }
    if (typeof e.ruleTag !== 'string' || e.ruleTag.length === 0) {
      return { ok: false, reason: 'rule.ruleTag must be a non-empty string' };
    }
    // Reject obviously malformed upstream early so the host sees a structured
    // error instead of CDP-layer surprises later. parseUpstream throws on
    // unparseable input; we only validate, no I/O.
    try {
      parseUpstream(e.upstream);
    } catch (err) {
      return { ok: false, reason: `rule.upstream is not a valid URL: ${(err as Error).message}` };
    }
    rules.push({
      originPattern: e.originPattern,
      upstream: e.upstream,
      ruleTag: e.ruleTag,
    });
  }
  return { ok: true, rules };
}

function buildAppliedReport(state: ReadonlyArray<BindingState>): ProxyBindingReport[] {
  const byTag = new Map<string, ProxyBindingReport>();
  for (const b of state) {
    let report = byTag.get(b.rule.ruleTag);
    if (report === undefined) {
      report = { ruleTag: b.rule.ruleTag, bindings: [] };
      byTag.set(b.rule.ruleTag, report);
    }
    report.bindings.push({
      tabId: b.tabId,
      origin: b.rule.originPattern,
      status: 'ok',
    });
  }
  return Array.from(byTag.values());
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  if (!isProxyHookEnabled()) {
    return jsonResult<ProxyHookOutput>({
      ok: false,
      reason: 'disabled',
      error_message:
        'proxy_hook family is disabled — start the server with `--pilot` ' +
        'and export OPENCHROME_PROXY_HOOK=1.',
    });
  }

  const action = args.action;
  if (action !== 'apply' && action !== 'clear' && action !== 'status' && action !== 'rotate') {
    return jsonResult<ProxyHookOutput>({
      ok: false,
      reason: 'invalid_args',
      error_message: 'action must be one of: apply, clear, status, rotate',
    });
  }

  // Resolve target tab: empty string treated same as undefined. We never
  // open a CDP session from this call site — the per-tab CDP layer reads
  // `getProxyBindingsSnapshot()` lazily on each network event. This keeps
  // invariant I1 (no outbound HTTP during apply/status) trivially true.
  const tabIdArg = args.tabId;
  const tabId =
    typeof tabIdArg === 'string' && tabIdArg.length > 0 ? tabIdArg : `session:${sessionId}`;

  if (action === 'clear') {
    bindings = [];
    return jsonResult<ProxyHookOutput>({
      ok: true,
      applied_rules: [],
      captured_at: Date.now(),
    });
  }

  if (action === 'status') {
    return jsonResult<ProxyHookOutput>({
      ok: true,
      applied_rules: buildAppliedReport(bindings),
      captured_at: Date.now(),
    });
  }

  // apply / rotate share the same body: validate the supplied rules, then
  // swap state atomically. Rotation NEVER picks the upstream — it only
  // re-binds whatever the host passed in (invariant I2).
  const validated = validateRules(args.rules);
  if (!validated.ok) {
    return jsonResult<ProxyHookOutput>({
      ok: false,
      reason: 'invalid_args',
      error_message: validated.reason,
    });
  }

  bindings = snapshotBindings(validated.rules, tabId);
  return jsonResult<ProxyHookOutput>({
    ok: true,
    applied_rules: buildAppliedReport(bindings),
    captured_at: Date.now(),
  });
};

/**
 * Register the proxy-hook tool onto the given server. Idempotent per server.
 * Callers MUST gate on `isProxyHookEnabled()` before invoking — registering
 * the tool unconditionally would defeat the registration-snapshot test that
 * asserts `oc_proxy_hook` is absent from `tools/list` when the family is off
 * (acceptance criterion #4).
 */
export function registerOcProxyHookTool(server: MCPServer): void {
  server.registerTool('oc_proxy_hook', handler, definition);
}

// Expose the definition so tests can assert on the schema without binding
// to a live MCPServer instance.
export const __TEST_ONLY__ = {
  definition,
  handler,
};
