import * as fs from 'fs';
import * as path from 'path';

const outDir = path.join('artifacts', 'decision', 'G3');
const jsonPath = path.join(outDir, 'implementation-map.json');
const mdPath = path.join(outDir, 'IMPLEMENTATION_MAP.md');

interface CodeAnchor {
  readonly path: string;
  readonly symbol: string;
  readonly evidence: string;
  readonly current_role: string;
}

interface InsertionMap {
  readonly insertion: string;
  readonly recommendation: string;
  readonly implementation_status: 'candidate' | 'deferred' | 'exclude_candidate';
  readonly current_behavior: string;
  readonly proposed_jev_role: string;
  readonly primary_anchors: readonly CodeAnchor[];
  readonly guardrails: readonly string[];
  readonly verification: readonly string[];
}

interface ImplementationMap {
  readonly generated_at: string;
  readonly source_memo: string;
  readonly maps: readonly InsertionMap[];
}

function ensureFiles(paths: readonly string[]): void {
  const missing = paths.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) throw new Error(`missing implementation anchors: ${missing.join(', ')}`);
}

function ensureAnchorEvidence(report: ImplementationMap): void {
  const failures: string[] = [];
  for (const item of report.maps) {
    for (const anchor of item.primary_anchors) {
      const text = fs.readFileSync(anchor.path, 'utf8');
      if (!text.includes(anchor.evidence)) failures.push(`${item.insertion}: ${anchor.path} missing ${anchor.evidence}`);
    }
  }
  if (failures.length > 0) throw new Error(`stale implementation anchors: ${failures.join('; ')}`);
}

function makeMap(): ImplementationMap {
  const anchors = [
    'src/recovery/ralph/outcome-classifier.ts',
    'src/recovery/ralph/ralph-engine.ts',
    'src/tools/act.ts',
    'src/tools/interact.ts',
    'src/dom/ax-element-resolver.ts',
    'src/security/tool-risk-policy.ts',
    'src/tools/oc-policy.ts',
    'src/core/lifecycle/events.ts',
    'src/pilot/runtime/before-irreversible.ts',
    'src/pilot/runtime/runtime.ts',
    'src/pilot/decider/providers.ts',
  ];
  ensureFiles(anchors);
  return {
    generated_at: new Date().toISOString(),
    source_memo: path.join(outDir, 'decision-memo.json'),
    maps: [
      {
        insertion: 'outcome_classification',
        recommendation: 'candidate',
        implementation_status: 'candidate',
        current_behavior: 'Deterministic DOM-delta outcome classification already drives act/interact/Ralph retry behavior for SILENT_CLICK and WRONG_ELEMENT.',
        proposed_jev_role: 'Use Jev only as a bounded reviewer when deterministic classifyOutcome returns SILENT_CLICK or WRONG_ELEMENT; do not replace the existing success fast path.',
        primary_anchors: [
          { path: 'src/recovery/ralph/outcome-classifier.ts', symbol: 'classifyOutcome', evidence: 'export function classifyOutcome', current_role: 'Deterministic DOM-delta classifier that emits SUCCESS, SILENT_CLICK, WRONG_ELEMENT, and failure classes.' },
          { path: 'src/recovery/ralph/ralph-engine.ts', symbol: 'ralphClick', evidence: 'export async function ralphClick', current_role: 'Retries alternate click strategies when outcome is SILENT_CLICK or WRONG_ELEMENT.' },
          { path: 'src/tools/act.ts', symbol: 'executeClick', evidence: 'async function executeClick', current_role: 'Captures DOM delta with withDomDelta and formats classified outcome in act responses.' },
          { path: 'src/tools/interact.ts', symbol: 'AX and CSS interaction paths', evidence: 'const classifiedAxOutcome = classifyOutcome', current_role: 'Classifies AX-path and CSS-path interaction outcomes after DOM delta capture.' },
          { path: 'src/pilot/decider/providers.ts', symbol: 'createTypeSafeDecisionProvider', evidence: 'export function createTypeSafeDecisionProvider', current_role: 'Provides SystemOne and Vercel AI Gateway Jev request path.' },
        ],
        guardrails: [
          'Do not call Jev on SUCCESS outcomes.',
          'Keep label and truth_hint out of provider input.',
          'Keep G2 bounded view limits for any state sent to Jev.',
          'Record deterministic outcome, Jev answer, confidence, and actual follow-up result separately.',
        ],
        verification: [
          'Run existing outcome classifier tests or add focused cases around SILENT_CLICK and WRONG_ELEMENT routing.',
          'Run G3 B insertion tables with a non-skipped Jev column before claiming benefit.',
          'Keep preflight closed until host-file and approval records are present.',
        ],
      },
      {
        insertion: 'irreversible_policy',
        recommendation: 'candidate',
        implementation_status: 'candidate',
        current_behavior: 'Deterministic tool-risk policy and pilot irreversible-action hook already gate critical actions through preview, checkpoint, elicitation, or block decisions.',
        proposed_jev_role: 'Use Jev as a policy reviewer for mutation actions before execution, with deterministic policy remaining the hard safety boundary.',
        primary_anchors: [
          { path: 'src/security/tool-risk-policy.ts', symbol: 'evaluateToolRiskPolicy', evidence: 'export function evaluateToolRiskPolicy', current_role: 'Evaluates deterministic irreversible-action policy decisions.' },
          { path: 'src/tools/oc-policy.ts', symbol: 'ocPolicyToolHandler', evidence: 'export const ocPolicyToolHandler', current_role: 'Exposes the deterministic policy matrix and evaluate path for inspection.' },
          { path: 'src/core/lifecycle/events.ts', symbol: 'irreversible-action:before', evidence: "kind: 'irreversible-action:before'", current_role: 'Lifecycle event emitted before critical irreversible actions.' },
          { path: 'src/pilot/runtime/before-irreversible.ts', symbol: 'getBeforeIrreversibleHook', evidence: 'export function getBeforeIrreversibleHook', current_role: 'Pilot runtime hook accessor that can abort critical actions before execution.' },
          { path: 'src/pilot/runtime/runtime.ts', symbol: 'irreversible hook callsite', evidence: 'const hook = getBeforeIrreversibleHook()', current_role: 'Pilot runtime callsite that invokes the irreversible hook before execution.' },
          { path: 'src/pilot/decider/providers.ts', symbol: 'createTypeSafeDecisionProvider', evidence: 'export function createTypeSafeDecisionProvider', current_role: 'Provides the outbound Jev reviewer path once trust and key are present.' },
        ],
        guardrails: [
          'Jev may escalate but must not downgrade deterministic block, checkpoint_required, or elicitation_required decisions.',
          'Every mutation action remains in scope until an approved narrower trigger exists.',
          'Keep irreversible-action records separate from final execution receipts.',
          'Never run this path without explicit trust-model approval and outbound budget accounting.',
        ],
        verification: [
          'Run oc_policy evaluate fixtures for allow, checkpoint_required, elicitation_required, and block decisions.',
          'Run G3 insertion table for irreversible_policy with Jev non-skipped before claiming benefit.',
          'Confirm lifecycle irreversible-action:before still emits before hook decisions.',
        ],
      },
      {
        insertion: 'element_search',
        recommendation: 'defer',
        implementation_status: 'deferred',
        current_behavior: 'AX and CSS element resolution already produce match-level and score-like diagnostics, but the G3 corpus does not preserve AX cascade level or CSS score as A evidence.',
        proposed_jev_role: 'Do not route element search to Jev yet; first add telemetry to preserve AX cascade level and CSS score in A-run records.',
        primary_anchors: [
          { path: 'src/dom/ax-element-resolver.ts', symbol: 'MATCH_LEVEL_LABELS', evidence: 'export const MATCH_LEVEL_LABELS', current_role: 'Existing AX resolver exports match-level labels used by interaction responses.' },
          { path: 'src/tools/interact.ts', symbol: 'CSS bestMatch.score paths', evidence: 'bestMatch.score < 50', current_role: 'Existing interaction code has CSS confidence display and low-confidence threshold.' },
          { path: 'src/core/perception/semantic.ts', symbol: 'classifyKind', evidence: 'function classifyKind', current_role: 'Semantic classification contributes to element discovery.' },
          { path: 'src/dom/element-finder.ts', symbol: 'scoreElement', evidence: 'export function scoreElement', current_role: 'Candidate source for future score telemetry.' },
        ],
        guardrails: [
          'Do not introduce Jev element routing until A-only thresholds are frozen.',
          'Do not treat regex element scores as CSS scores.',
          'Record telemetry before changing routing behavior.',
        ],
        verification: [
          'Add A-run records with AX cascade level for every element-search decision point.',
          'Add A-run records with CSS score for every element-search decision point.',
          'Regenerate thresholds:g3, freeze-gaps:g3, approval:g3, and memo:g3.',
        ],
      },
      {
        insertion: 'gate_detection',
        recommendation: 'exclude_candidate',
        implementation_status: 'exclude_candidate',
        current_behavior: 'No gate cases exist in the current decision corpus, so G3 cannot evaluate this insertion.',
        proposed_jev_role: 'Exclude from G3 unless new labeled gate cases are added to A and B.',
        primary_anchors: [
          { path: 'src/captcha/detect.ts', symbol: 'captcha detection', evidence: 'detectCaptcha', current_role: 'Potential future gate corpus source.' },
          { path: 'src/tools/login-detector.ts', symbol: 'classifyLoginSignals', evidence: 'export function classifyLoginSignals', current_role: 'Potential future login gate corpus source.' },
        ],
        guardrails: [
          'Do not claim gate_detection coverage from a zero-case corpus.',
          'Require labeled A and B gate cases before go/no-go if this insertion remains in scope.',
        ],
        verification: [
          'Add labeled gate cases or approve G3 exclusion.',
          'Regenerate split, thresholds, insertion tables, approval request, and memo if cases are added.',
        ],
      },
    ],
  };
}

function markdown(report: ImplementationMap): string {
  const lines = [
    '# G3 implementation map',
    '',
    `Generated: ${report.generated_at}`,
    '',
    `Source memo: \`${report.source_memo}\``,
    '',
  ];
  for (const item of report.maps) {
    lines.push(`## ${item.insertion}`, '');
    lines.push(`Recommendation: ${item.recommendation}`);
    lines.push('');
    lines.push(`Implementation status: ${item.implementation_status}`);
    lines.push('');
    lines.push(`Current behavior: ${item.current_behavior}`);
    lines.push('');
    lines.push(`Proposed Jev role: ${item.proposed_jev_role}`);
    lines.push('', '### Code anchors', '');
    lines.push('| path | symbol | evidence | current role |');
    lines.push('| --- | --- | --- | --- |');
    for (const anchor of item.primary_anchors) lines.push(`| \`${anchor.path}\` | \`${anchor.symbol}\` | \`${anchor.evidence}\` | ${anchor.current_role} |`);
    lines.push('', '### Guardrails', '');
    for (const guardrail of item.guardrails) lines.push(`- ${guardrail}`);
    lines.push('', '### Verification', '');
    for (const check of item.verification) lines.push(`- ${check}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const report = makeMap();
  ensureAnchorEvidence(report);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, markdown(report), 'utf8');
  console.log(JSON.stringify({ output: jsonPath, candidates: report.maps.filter((item) => item.implementation_status === 'candidate').map((item) => item.insertion) }, null, 2));
}

main();
