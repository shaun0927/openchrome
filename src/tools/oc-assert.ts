/**
 * oc_assert — single-call Outcome Contract assertion (issue #784).
 *
 * Runs ONE contract assertion against caller-supplied evidence (snapshot)
 * and returns a verdict. This is the core-tier surface from PR #774's
 * portability-harness contract: no retry, no escalation, no irreversible-
 * action gating — those live in the pilot runtime (#749, #750).
 *
 * Design notes:
 *  - The DSL in src/contracts/ does not (yet) expose a contract-by-id
 *    registry. To keep this PR scoped, `oc_assert` accepts the Assertion
 *    inline under `contract`. `contract_id` is reserved as an optional
 *    forward-compatible field; today it surfaces a clear error if used
 *    without `contract`.
 *  - Evaluation is snapshot-driven: callers pre-capture the page state
 *    (url, dom text/count, network, screenshot bytes, dialog flag) and
 *    pass it in `evidence.snapshot`. Live browser plumbing belongs to
 *    the pilot runtime; the core tool stays a pure verifier.
 *  - `evidence_handle` is a UUID placeholder that future
 *    `oc_evidence_bundle` (#792) will consume to materialize a
 *    downloadable archive. v1.11 does not persist these handles.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolContext, ToolHandler } from '../types/mcp';
import { runImageQaSampling } from './image-qa';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { evaluate } from '../contracts/evaluate';
import { validateAssertion } from '../contracts/validator';
import { getActiveActionRecorder } from '../recording/action-recorder';
import type { EvalContext, NetworkLogEntry } from '../contracts/eval-context';
import { primaryFailureCategory } from '../failure/classifier';
import type { FailureCategory } from '../failure/categories';
import type {
  Assertion,
  EvaluationResult,
  Evidence,
  NetworkSinceMarker,
} from '../contracts/types';

type Verdict = 'pass' | 'fail' | 'inconclusive';

interface FailedAssertion {
  name: string;
  expected: unknown;
  actual: unknown;
  location?: string;
}

interface OcAssertOutput {
  verdict: Verdict;
  failed_assertions?: FailedAssertion[];
  /**
   * Machine-stable failure category on a `fail` verdict, so a host agent can
   * branch recovery (retry vs re-auth vs solve-captcha) instead of re-parsing
   * raw expected/actual diffs (#1457 PR-5 / SSOT P4 — facts the host can act on).
   */
  failure_category?: FailureCategory;
  failure_reason?: string;
  evidence_handle?: string;
  evidence?: Evidence;
  validation_errors?: Array<{ path: string; message: string }>;
  inconclusive_reason?: string;
}

interface SnapshotInput {
  url?: string;
  dom_text?: Record<string, string | null> | string | null;
  dom_count?: Record<string, number>;
  network?: NetworkLogEntry[];
  /** PNG bytes, base64 encoded. */
  screenshot_png_base64?: string;
  has_open_dialog?: boolean;
}

const definition: MCPToolDefinition = {
  name: 'oc_assert',
  description:
    'Evaluate a single Outcome Contract assertion against caller-supplied ' +
    'evidence (snapshot). Returns verdict pass/fail/inconclusive plus the ' +
    'list of failed leaf assertions. Core-tier single-call surface; retry ' +
    'and escalation live in the pilot runtime.',
  inputSchema: {
    type: 'object',
    properties: {
      contract_id: {
        type: 'string',
        description:
          'Optional identifier for a registered contract. Reserved for ' +
          'forward compatibility — currently no registry exists, so callers ' +
          'must supply `contract` inline.',
      },
      contract: {
        type: 'object',
        description:
          'Assertion DSL object (see src/contracts/types.ts: kind ∈ ' +
          'url|dom_text|dom_count|network|screenshot_class|no_dialog|image_qa|and|or|not). ' +
          'Validated via validateAssertion() before evaluation.',
      },
      args: {
        type: 'object',
        description:
          'Reserved for future contract templating. Ignored in v1.11.',
      },
      evidence: {
        type: 'object',
        description:
          'Pre-captured page evidence. Required for evaluation; without it ' +
          'the verdict is `inconclusive`.',
        properties: {
          snapshot: {
            type: 'object',
            description:
              'Snapshot fields. Provide the subset the assertion needs: ' +
              '`url` (string), `dom_text` (string | { selector: string|null }), ' +
              '`dom_count` ({ selector: number }), `network` (NetworkLogEntry[]), ' +
              '`screenshot_png_base64` (base64 PNG), `has_open_dialog` (boolean).',
          },
        },
      },
    },
    required: [],
  },
  annotations: TOOL_ANNOTATIONS.oc_assert,
};

function buildEvalContext(
  snapshot: SnapshotInput | undefined,
  toolContext?: ToolContext,
): EvalContext {
  const domTextMap =
    snapshot && typeof snapshot.dom_text === 'object' && snapshot.dom_text !== null
      ? (snapshot.dom_text as Record<string, string | null>)
      : undefined;
  const defaultDomText =
    snapshot && (typeof snapshot.dom_text === 'string' || snapshot.dom_text === null)
      ? (snapshot.dom_text as string | null)
      : null;

  let screenshotBuffer: Buffer | null = null;
  if (snapshot?.screenshot_png_base64) {
    try {
      screenshotBuffer = Buffer.from(snapshot.screenshot_png_base64, 'base64');
    } catch {
      screenshotBuffer = null;
    }
  }

  return {
    async url() {
      return snapshot?.url ?? '';
    },
    async domText(selector) {
      if (domTextMap && selector !== undefined && selector in domTextMap) {
        return domTextMap[selector];
      }
      return defaultDomText;
    },
    async domCount(selector) {
      return snapshot?.dom_count?.[selector] ?? 0;
    },
    async networkSince(_marker: NetworkSinceMarker) {
      // The `since` marker is meaningful only with a live runtime that
      // tracks tool-call boundaries. For snapshot-driven evaluation the
      // caller is expected to supply only entries relevant to the
      // assertion, so we return the entire array regardless of marker.
      return snapshot?.network ?? [];
    },
    async screenshotPng() {
      return screenshotBuffer;
    },
    async hasOpenDialog() {
      return snapshot?.has_open_dialog ?? false;
    },
    // image_qa contract evaluator hook (#1432 Part 2 runtime wire-up).
    // Forwards to the host LLM via MCP sampling when the connected
    // client advertises the capability. When ToolContext is absent
    // (older callers) or sampling is not available, the hook is
    // omitted and the evaluator falls back to inconclusive.
    ...(toolContext
      ? {
          imageQaSample: async ({
            question,
            screenshot,
          }: {
            question: string;
            screenshot: Buffer;
          }) => {
            const reply = await runImageQaSampling(toolContext, {
              question,
              base64: screenshot.toString('base64'),
              mime: 'image/png',
            });
            if (reply.status === 'ok') {
              return { status: 'ok' as const, answer: reply.answer };
            }
            if (reply.status === 'unsupported_by_host') {
              return { status: 'unsupported_by_host' as const, reason: reply.reason };
            }
            // status === 'error' — surface as unsupported_by_host so
            // the evaluator returns inconclusive with the original
            // error reason preserved for diagnostics.
            return { status: 'unsupported_by_host' as const, reason: reply.reason };
          },
        }
      : {}),
  };
}

/**
 * Walk the evidence tree and collect failed leaf evidences.
 *
 * The evaluator records each leaf evaluation's evidence; logical nodes
 * (and/or/not) attach their children's evidence under `details.children`
 * (or `details.child` for `not`). We flatten failures so callers see
 * exactly which leaf assertions tripped.
 */
function collectFailedAssertions(
  assertion: Assertion,
  evidence: Evidence,
  pathPrefix: string,
): FailedAssertion[] {
  if (evidence.passed) return [];

  const out: FailedAssertion[] = [];

  if (assertion.kind === 'and' || assertion.kind === 'or') {
    const childEvidences = (evidence.details.children as Evidence[] | undefined) ?? [];
    for (let i = 0; i < assertion.children.length && i < childEvidences.length; i++) {
      out.push(
        ...collectFailedAssertions(
          assertion.children[i],
          childEvidences[i],
          `${pathPrefix}.children.${i}`,
        ),
      );
    }
    if (out.length > 0) return out;
    // If we could not crack the logical node open, fall through and emit
    // a single record for the node itself so callers still see something.
  } else if (assertion.kind === 'not') {
    const childEvidence = evidence.details.child as Evidence | undefined;
    if (childEvidence) {
      // For `not`, the leaf "failed" because the child passed. Surface
      // the child as the actionable record.
      out.push({
        name: `${pathPrefix}.child[${assertion.child.kind}]`,
        expected: { negated: true },
        actual: childEvidence.details,
      });
      return out;
    }
  }

  // Leaf (or undecodable logical node): emit one record.
  const { expected, actual } = expectedActualFor(assertion, evidence);
  out.push({
    name: `${pathPrefix}[${assertion.kind}]`,
    expected,
    actual,
    location: pathPrefix,
  });
  return out;
}

function expectedActualFor(
  assertion: Assertion,
  evidence: Evidence,
): { expected: unknown; actual: unknown } {
  switch (assertion.kind) {
    case 'url':
      return {
        expected: { pattern: assertion.pattern },
        actual: evidence.details.url ?? null,
      };
    case 'dom_text':
      return {
        expected: { selector: assertion.selector ?? 'body', contains: assertion.contains },
        actual: {
          text_preview: evidence.details.text_preview ?? null,
          text_length: evidence.details.text_length ?? 0,
        },
      };
    case 'dom_count':
      return {
        expected: { selector: assertion.selector, op: assertion.op, value: assertion.value },
        actual: { count: evidence.details.count ?? null },
      };
    case 'network':
      return {
        expected: {
          url_pattern: assertion.url_pattern,
          status_in: assertion.status_in,
          since: assertion.since,
        },
        actual: evidence.details,
      };
    case 'screenshot_class':
      return {
        expected: { class_id: assertion.class_id, distance_max: assertion.distance_max },
        actual: evidence.details,
      };
    case 'no_dialog':
      return {
        expected: { no_dialog: true },
        actual: { has_open_dialog: evidence.details.has_open_dialog ?? null },
      };
    case 'image_qa':
      return {
        expected: {
          question: assertion.question,
          expected_pattern: assertion.expected_pattern,
        },
        actual: evidence.details,
      };
    case 'and':
    case 'or':
    case 'not':
      return { expected: { kind: assertion.kind }, actual: evidence.details };
  }
}

function isInconclusive(evidence: Evidence): boolean {
  // The evaluator signals undecidable evaluations by stamping an `error`
  // string in details (e.g. screenshot_class with no registry hook, or a
  // network entry list the runtime could not provide). We treat any such
  // top-level error as inconclusive rather than a hard fail.
  return typeof evidence.details.error === 'string';
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  const contractInline = args.contract;
  const contractId = args.contract_id as string | undefined;

  if (contractInline === undefined) {
    if (contractId !== undefined) {
      const output: OcAssertOutput = {
        verdict: 'inconclusive',
        inconclusive_reason:
          'contract_id lookup is not yet implemented; pass the assertion ' +
          'inline via `contract`.',
      };
      return jsonResult(output);
    }
    const output: OcAssertOutput = {
      verdict: 'inconclusive',
      inconclusive_reason: 'missing required field: `contract`',
    };
    return jsonResult(output);
  }

  const validation = validateAssertion(contractInline);
  if (!validation.ok) {
    const output: OcAssertOutput = {
      verdict: 'inconclusive',
      inconclusive_reason: 'contract failed schema validation',
      validation_errors: validation.errors,
    };
    return jsonResult(output);
  }

  const evidenceArg = args.evidence as { snapshot?: SnapshotInput } | undefined;
  const snapshot = evidenceArg?.snapshot;

  // Without any snapshot the verdict is inconclusive — there is no live
  // browser binding in the core tool. The pilot runtime drives evaluation
  // against an actual page.
  if (!snapshot) {
    const output: OcAssertOutput = {
      verdict: 'inconclusive',
      inconclusive_reason:
        'no evidence.snapshot provided; oc_assert is a pure verifier and ' +
        'cannot capture page state on its own.',
    };
    return jsonResult(output);
  }

  const ctx = buildEvalContext(snapshot, context);
  let result: EvaluationResult;
  try {
    result = await evaluate(validation.value, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output: OcAssertOutput = {
      verdict: 'inconclusive',
      inconclusive_reason: `evaluator threw: ${message}`,
    };
    return jsonResult(output);
  }

  let verdict: Verdict;
  if (isInconclusive(result.evidence)) {
    verdict = 'inconclusive';
  } else if (result.passed) {
    verdict = 'pass';
  } else {
    verdict = 'fail';
  }

  const output: OcAssertOutput = {
    verdict,
    evidence: result.evidence,
    evidence_handle: makeEvidenceHandle(),
  };

  if (verdict === 'fail') {
    output.failed_assertions = collectFailedAssertions(validation.value, result.evidence, '$');
    const classified = deriveFailureCategory(result.evidence, output.failed_assertions);
    output.failure_category = classified.category;
    output.failure_reason = classified.reason;
  } else if (verdict === 'inconclusive') {
    output.inconclusive_reason =
      typeof result.evidence.details.error === 'string'
        ? (result.evidence.details.error as string)
        : 'evaluation was inconclusive';
  }

  // Wire into active recording: append verdict to most-recent action's contractResults.
  // No-op if no recording is active for this session or if no action has been recorded yet.
  const recorder = getActiveActionRecorder(sessionId);
  if (recorder) {
    recorder.appendContractResult({
      assertion: contractInline,
      verdict,
      details: result.evidence.details as Record<string, unknown> | undefined,
    }).catch((err: unknown) => {
      console.error('[oc_assert] Failed to append contract result to recorder:', err instanceof Error ? err.message : err);
    });
  }

  return jsonResult(output);
};

/**
 * Map an oc_assert failure to a structured, host-actionable failure category
 * (#1457 PR-5 / SSOT P4). A clean expected/actual mismatch is POSTCONDITION_FAILED;
 * when an evaluator surfaced an error string (e.g. a detached node or a navigation
 * timeout caught by the evaluator) we classify that instead, so a host can branch
 * recovery rather than re-reading raw diffs. Purely deterministic — no LLM.
 */
export function deriveFailureCategory(
  evidence: Evidence,
  failed: FailedAssertion[],
): { category: FailureCategory; reason: string } {
  const errorTexts: string[] = [];
  const collectError = (details: unknown): void => {
    if (details && typeof details === 'object' && !Array.isArray(details)) {
      const err = (details as Record<string, unknown>).error;
      if (typeof err === 'string' && err.length > 0) errorTexts.push(err);
    }
  };
  // A top-level evidence error routes to `inconclusive` (see isInconclusive), so
  // on a `fail` verdict the reachable error source is usually a logical child
  // leaf surfaced in `fa.actual`; we still scan both for completeness.
  collectError(evidence.details);
  for (const fa of failed) collectError(fa.actual);

  for (const text of errorTexts) {
    // With `fallbackToUnknown: false`, primaryFailureCategory returns undefined
    // (never UNKNOWN) when no rule matches, so a falsy result means "fall back".
    const classified = primaryFailureCategory({ message: text, fallbackToUnknown: false });
    if (classified) {
      return { category: classified.category, reason: classified.reason };
    }
  }
  return {
    category: 'POSTCONDITION_FAILED',
    reason: 'the contract postcondition did not hold (expected/actual mismatch)',
  };
}

function makeEvidenceHandle(): string {
  // Placeholder for #792 oc_evidence_bundle. The handle is currently not
  // persisted; the pilot runtime / a future evidence store will materialize
  // it when oc_evidence_bundle lands.
  return `ev_${cryptoRandomUUID()}`;
}

function cryptoRandomUUID(): string {
  // crypto is globally available on Node ≥ 19; require() avoids pulling
  // type-only imports into the build surface.
  const c: { randomUUID?: () => string } | undefined =
    (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // Fallback: time + random. We do not use this for cryptographic purposes.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function jsonResult(payload: OcAssertOutput): MCPResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
    ...payload,
  };
}

export function registerOcAssertTool(server: MCPServer): void {
  server.registerTool('oc_assert', handler, definition);
}
