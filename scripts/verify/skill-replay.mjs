#!/usr/bin/env node
/**
 * skill-replay.mjs — reproducer for the six verification scenarios in #875.
 *
 * This script is host-orchestrated (it expects `mcp__openchrome__*` tools to be
 * callable from the host LLM). It is NOT meant to be run directly with `node`;
 * `node --check` is the only static guarantee we ship here. The script prints
 * the deterministic invocation sequence so an operator (or autopilot loop) can
 * re-run the scenarios verbatim.
 *
 * Pre-req: `npm run fixture-serve` is running on port 4173 with the bundled
 * fixture at `tests/fixtures/skill-replay/index.html` exposed at
 * `http://localhost:4173/skill-replay/`.
 */

const FIXTURE_URL = 'http://localhost:4173/skill-replay/';
const DOMAIN = 'localhost';
const SKILL_NAME = 'form-flow';

const scenarios = [
  {
    id: 1,
    label: 'record-then-replay happy path',
    steps: [
      { tool: 'navigate', args: { url: FIXTURE_URL } },
      { tool: 'interact', args: { action: 'fill', target: { text: 'Name' }, value: 'Alice', capture_artifact: true } },
      { tool: 'interact', args: { action: 'fill', target: { text: 'Email' }, value: 'a@b.co', capture_artifact: true } },
      { tool: 'interact', args: { action: 'fill', target: { text: 'Captcha' }, value: '1234', capture_artifact: true } },
      { tool: 'interact', args: { action: 'click', target: { text: 'Submit' }, capture_artifact: true } },
      { tool: 'oc_skill_record', args: { domain: DOMAIN, name: SKILL_NAME, contract_id: 'demo' } },
      { tool: 'page_reload', args: {} },
      { tool: 'oc_skill_recall', args: { domain: DOMAIN, name: SKILL_NAME } },
      { tool: 'oc_skill_replay', args: { domain: DOMAIN, name: SKILL_NAME } },
    ],
    expect: 'ok=true, steps_executed=4, resolved_via != "text"',
  },
  {
    id: 2,
    label: 'artifact-resolution failure returns control to host',
    steps: [
      '<run scenario 1 through step 8>',
      '<mutate fixture: rename "Captcha" label to "Verification code">',
      { tool: 'oc_skill_replay', args: { domain: DOMAIN, name: SKILL_NAME } },
    ],
    expect: 'ok=false, failure.code="ARTIFACT_RESOLUTION_FAILED", step_index=2',
  },
  {
    id: 3,
    label: 'P3 compliance — zero outbound calls',
    steps: [
      '<block egress via pf/iptables to 127.0.0.1>',
      { tool: 'oc_skill_replay', args: { domain: DOMAIN, name: SKILL_NAME } },
    ],
    expect: 'completes successfully; tcpdump shows no non-loopback traffic',
  },
  {
    id: 4,
    label: 'P2 byte-parity when capture_artifact is omitted',
    steps: [
      '<record JSONL baseline trace without capture_artifact>',
      '<re-run automation on merged build, also without capture_artifact>',
      '<diff result.* sections of both traces>',
    ],
    expect: 'diff is empty',
  },
  {
    id: 5,
    label: 'kill-switch — OPENCHROME_SKILL_REPLAY=0',
    steps: [
      '<launch with OPENCHROME_SKILL_REPLAY=0>',
      { tool: 'oc_skill_replay', args: { domain: DOMAIN, name: SKILL_NAME } },
    ],
    expect: 'ok=false, failure.code="DISABLED"; tools/list still lists oc_skill_replay',
  },
  {
    id: 6,
    label: 'schema migration — v1 records surface ARTIFACT_MISSING',
    steps: [
      '<seed ~/.openchrome/skill-memory/localhost/skills.json with a v1 record>',
      { tool: 'oc_skill_recall', args: { domain: DOMAIN } },
      { tool: 'oc_skill_replay', args: { domain: DOMAIN, name: SKILL_NAME } },
    ],
    expect: 'oc_skill_replay returns ok=false, failure.code="ARTIFACT_MISSING"',
  },
];

for (const s of scenarios) {
  // eslint-disable-next-line no-console
  console.log(`\n=== Scenario ${s.id}: ${s.label}`);
  for (const step of s.steps) {
    // eslint-disable-next-line no-console
    console.log(`  - ${typeof step === 'string' ? step : `${step.tool}: ${JSON.stringify(step.args)}`}`);
  }
  // eslint-disable-next-line no-console
  console.log(`  expect: ${s.expect}`);
}
