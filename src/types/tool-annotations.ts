/**
 * Canonical tool-annotation table.
 *
 * This file is the **single source of truth** for the `ToolAnnotations` MCP
 * spec field exposed via `tools/list`. Every tool registered with `MCPServer`
 * MUST appear here; the runtime registration path (`MCPServer.registerTool`)
 * looks up annotations from this table at startup and throws when an entry is
 * missing. There are no defaults.
 *
 * Semantics (recap — full definition in `./mcp.ts` `ToolAnnotations`):
 * - `readOnlyHint`      — worst-case across all inputs, no mutation
 * - `destructiveHint`   — at least one input deletes / terminates / blocks
 * - `idempotentHint`    — every input is observably idempotent
 * - `openWorldHint`     — at least one input triggers network egress
 *
 * The Markdown mirror at `docs/mcp/tool-annotations.md` exists for human
 * review and PR diff readability; CI keeps the two in sync via
 * `tests/unit/tool-annotations.test.ts`.
 */

import type { ToolAnnotations } from './mcp';

/** Pure-read shorthand: no mutation, idempotent, no network. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Mutating but not destructive, no network. */
const MUTATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Destructive (deletes/terminates/blocks). */
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/** Network-egress (open world), not destructive, not read-only. */
const OPEN_WORLD: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Network-egress + destructive (e.g. request_intercept block). */
const OPEN_WORLD_DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export const TOOL_ANNOTATIONS = {
  // ── Pure reads ──────────────────────────────────────────────────────────
  inspect: READ_ONLY,
  query_dom: READ_ONLY,
  oc_query: READ_ONLY,
  find: READ_ONLY,
  read_page: READ_ONLY,
  page_content: READ_ONLY,
  tabs_context: READ_ONLY,
  list_profiles: READ_ONLY,
  // `console_capture` supports `clear` which deletes buffered logs, plus
  // `start`/`stop` which mutate module-level capture state — destructive
  // under the worst-case rule.
  console_capture: DESTRUCTIVE,
  performance_metrics: READ_ONLY,
  oc_profile_status: READ_ONLY,
  oc_get_connection_info: READ_ONLY,
  oc_connection_health: READ_ONLY,
  oc_policy: READ_ONLY,
  oc_skill_recall: READ_ONLY,
  vision_find: READ_ONLY,
  oc_assert: READ_ONLY,
  oc_recording_list: READ_ONLY,
  oc_recording_status: READ_ONLY,
  workflow_status: READ_ONLY,
  workflow_collect: READ_ONLY,
  workflow_collect_partial: READ_ONLY,
  wait_for: READ_ONLY,
  oc_doctor_report: READ_ONLY,
  oc_devtools_url: READ_ONLY,
  oc_context_export: READ_ONLY,
  oc_observe: READ_ONLY,
  oc_performance_analyze: READ_ONLY,
  oc_normalize_action: READ_ONLY,
  oc_progress_status: READ_ONLY,
  oc_vitals: READ_ONLY,

  // ── Network egress (navigation, crawling) ───────────────────────────────
  //
  // `validate_page` calls `smartGoto` (real navigation), can create a new tab
  // when `tabId` is omitted, and waits on live page state — open-world,
  // mutating, non-idempotent.
  //
  // `batch_paginate` presses keys, clicks selectors, and scrolls; in `url`
  // strategy it creates new tabs and navigates to generated URLs. At least
  // one valid input combination triggers non-loopback network egress, so the
  // worst-case envelope is open-world (which also implies non-read-only and
  // non-idempotent).
  navigate: OPEN_WORLD,
  page_reload: OPEN_WORLD,
  crawl: OPEN_WORLD,
  crawl_sitemap: OPEN_WORLD,
  validate_page: OPEN_WORLD,
  batch_paginate: OPEN_WORLD,
  oc_performance_insights: OPEN_WORLD,

  // ── Network-modifying / blocking / arbitrary-execution ──────────────────
  //
  // These are flagged DESTRUCTIVE because, under the worst-case rule, at
  // least one valid input causes deletion, request blocking, or terminates
  // observable state. Specifically:
  //   - `network` can `emulateNetworkConditions({ offline: true, ... })`
  //     which blocks every network request — destructive against network.
  //   - `request_intercept` installs blocking rules.
  //   - `javascript_tool` and `batch_execute` run arbitrary JS via
  //     Runtime.evaluate (or batch dispatch). Worst-case they `document.cookie
  //     = ''`, `window.close()`, fetch to arbitrary origins, or invoke a
  //     destructive sibling tool — so the worst-case envelope is
  //     destructive + open-world.
  //   - `act` parses NL into click/type/select/scroll/navigate; click can
  //     trigger irreversible browser-side mutations (Delete-account
  //     buttons, payment confirmations).
  network: OPEN_WORLD_DESTRUCTIVE,
  request_intercept: OPEN_WORLD_DESTRUCTIVE,
  javascript_tool: OPEN_WORLD_DESTRUCTIVE,
  batch_execute: OPEN_WORLD_DESTRUCTIVE,
  act: OPEN_WORLD_DESTRUCTIVE,
  oc_proxy_hook: OPEN_WORLD_DESTRUCTIVE,

  // ── Destructive (deletes / terminates / blocks) ─────────────────────────
  cookies: DESTRUCTIVE,
  storage: DESTRUCTIVE,
  tabs_close: DESTRUCTIVE,
  oc_stop: DESTRUCTIVE,
  oc_reap_orphans: DESTRUCTIVE,
  oc_recording_stop: DESTRUCTIVE,
  workflow_cleanup: DESTRUCTIVE,
  worker_complete: DESTRUCTIVE,

  // ── Mutating state (not destructive, no network) ────────────────────────
  computer: MUTATES,
  interact: MUTATES,
  form_input: MUTATES,
  fill_form: MUTATES,
  drag_drop: MUTATES,
  file_upload: MUTATES,
  http_auth: MUTATES,
  user_agent: MUTATES,
  geolocation: MUTATES,
  emulate_device: MUTATES,
  tabs_create: MUTATES,
  lightweight_scroll: MUTATES,
  // `memory` validate-prune path deletes memory entries — destructive under
  // the worst-case rule.
  memory: DESTRUCTIVE,
  oc_skill_record: MUTATES,
  oc_journal: MUTATES,
  oc_session_snapshot: MUTATES,
  oc_session_resume: MUTATES,
  oc_checkpoint: MUTATES,
  oc_evidence_bundle: MUTATES,
  oc_recording_start: MUTATES,
  oc_recording_export: MUTATES,
  oc_copy_to_clipboard: MUTATES,
  oc_open_host_settings: MUTATES,
  oc_totp_generate: MUTATES,
  page_pdf: MUTATES,
  page_screenshot: MUTATES,
  extract_data: MUTATES,
  worker: MUTATES,
  worker_update: MUTATES,
  // `workflow_init` performs `dnsResolve` and the worker calls `page.goto` to
  // non-loopback URLs — at least one valid input triggers network egress.
  workflow_init: OPEN_WORLD,
  // `execute_plan` resolves arbitrary tool names at runtime and dispatches them;
  // its worst-case set includes destructive tools and non-loopback navigations.
  execute_plan: OPEN_WORLD_DESTRUCTIVE,
  network_capture_lite: MUTATES,
  network_capture_full: MUTATES,
  oc_context_import: MUTATES,

  // ── Pilot tier (loaded only under --pilot) ──────────────────────────────
  oc_pilot_handoff_create: MUTATES,
  oc_pilot_handoff_redeem: MUTATES,

  // ── Crawl job control (develop-era additions merged after this PR) ─────
  // `crawl_start` issues network requests, so its worst-case input set
  // triggers network egress; `crawl_cancel` terminates an in-flight job;
  // `crawl_status` is a pure read of in-memory job state.
  crawl_start: OPEN_WORLD,
  crawl_cancel: DESTRUCTIVE,
  crawl_status: READ_ONLY,

  // ── Reflection / task ledger (develop-era additions) ────────────────────
  // `oc_reflect` mutates the reflection store under at least one action
  // (e.g. set/clear); only `get/list` are observably idempotent, so the
  // worst-case mark is MUTATES.
  oc_reflect: MUTATES,
  oc_task_start: MUTATES,
  oc_task_cancel: DESTRUCTIVE,
  oc_task_get: READ_ONLY,
  oc_task_list: READ_ONLY,
  oc_task_wait: READ_ONLY,

  // ── Skill replay (develop-era addition) ────────────────────────────────
  // `oc_skill_replay` performs the recorded CDP step sequence; the contract
  // gate may issue page.goto, so we mark it OPEN_WORLD_DESTRUCTIVE to match
  // the safety envelope of `execute_plan` above.
  oc_skill_replay: OPEN_WORLD_DESTRUCTIVE,

  // ── Run-harness lifecycle (develop-era additions) ──────────────────────
  oc_run_start: MUTATES,
  // `oc_run_status` is read-only without a budget, but budget-exceeded inputs
  // finish the run as needs_strategy_change and append ledger evidence.
  oc_run_status: MUTATES,
  oc_run_events: READ_ONLY,
  oc_run_finish: DESTRUCTIVE,

  // ── TaskRun goal-level lifecycle (#1039) ───────────────────────────────
  // `start` mutates by creating a new run row; update/checkpoint/needs_help
  // are bookkeeping mutations; complete is terminal (DESTRUCTIVE).
  // get/list are pure reads.
  oc_task_run_start: MUTATES,
  oc_task_run_update: MUTATES,
  oc_task_run_checkpoint: MUTATES,
  oc_task_run_needs_help: MUTATES,
  oc_task_run_complete: DESTRUCTIVE,
  oc_task_run_get: READ_ONLY,
  oc_task_run_list: READ_ONLY,

  // ── Virtual / runtime-only ──────────────────────────────────────────────
  // expand_tools is built inline by mcp-server.ts handleToolsList() and is
  // not registered through registerTool(); annotations declared here are
  // applied when the tool is synthesized.
  expand_tools: MUTATES,
} as const satisfies Record<string, ToolAnnotations>;

export type AnnotatedToolName = keyof typeof TOOL_ANNOTATIONS;

/**
 * Resolves a tool's annotation by name, throwing if no entry exists.
 *
 * NOTE: `MCPToolDefinition.annotations` is a required field, so the normal
 * `registerTool()` registration path enforces presence at compile time — no
 * runtime call is needed there. This helper is retained for callers that
 * synthesize tool definitions dynamically and want an explicit "fail closed"
 * check (e.g. future plugin-loaded tools, dynamic tool-name synthesis under
 * `--pilot`). It is intentionally not wired into `registerTool()` because
 * the test suite registers synthetic dummy tools with dynamic names that
 * legitimately do not appear in this table; those bring their own inline
 * annotations.
 */
export function requireAnnotations(toolName: string): ToolAnnotations {
  const entry = (TOOL_ANNOTATIONS as Record<string, ToolAnnotations | undefined>)[toolName];
  if (!entry) {
    throw new Error(
      `Tool '${toolName}' is registered without an entry in TOOL_ANNOTATIONS. ` +
        `Add it to src/types/tool-annotations.ts and the docs/mcp/tool-annotations.md mirror.`,
    );
  }
  return entry;
}
