# OpenChrome Capability Map

> Generated from `src/tools/index.ts`. Do not edit by hand; run `npm run docs:capability-map`.

Total tools: 118

## core

- `act` — Execute multi-step browser actions from a natural language instruction.
- `computer` — Mouse, keyboard, and screenshot actions on a tab.
- `console_capture` — Capture browser console output (start, stop, get, clear).
- `drag_drop` — Drag and drop by selector or coordinates.
- `element_pick` — Start or cancel an in-page human element picker overlay.
- `emulate_device` — Emulate device viewport and UA via preset or custom.
- `extract_data` — Extract JSON-schema data from JSON-LD, Microdata, OpenGraph, or CSS.
- `file_upload` — Upload files to a file input element on the page.
- `fill_form` — Fill form fields and optionally submit.
- `find` — Find elements by query.
- `form_input` — Set one form element value by ref.
- `geolocation` — Set or clear geolocation override.
- `http_auth` — Set or clear HTTP auth credentials.
- `image_qa` — Ask the connected host LLM a question about a caller-supplied screenshot.
- `inspect` — Extract focused page state by query.
- `interact` — Find element by natural language; click/hover/double_click it; wait for DOM settle; return state.
- `javascript_tool` — Execute JavaScript in page context.
- `lightweight_scroll` — Scroll page via JS.
- `memory` — Manage domain knowledge.
- `navigate` — Navigate to URL or go forward/back.
- `network` — Simulate network conditions.
- `network_capture_full` — Capture network requests with response bodies (capped).
- `network_capture_lite` — Capture network request metadata + headers (no bodies).
- `oc_assert` — Evaluate a single Outcome Contract assertion against caller-supplied evidence (snapshot).
- `oc_checkpoint` — Save, load, list, or delete automation checkpoints for long-running session continuity.
- `oc_connection_health` — Get CDP connection health metrics including heartbeat mode, reconnect count, ping latency, connection state, and live reconnection progress.
- `oc_context_export` — Export the active tab's auth-relevant state (cookies + local/sessionStorage + optional UA/viewport/HTTP-auth) as a portable plaintext envelope.
- `oc_context_import` — Strict-replace import of a `ContextEnvelope` produced by `oc_context_export`.
- `oc_copy_to_clipboard` — Copy text to the system clipboard.
- `oc_devtools_url` — Get the Chrome DevTools inspector URL for the current worker's active page.
- `oc_diff` — Compare two evidence-bundle IDs or paths and return deterministic DOM, screenshot phash, URL, console, and network diff facts.
- `oc_doctor_report` — Read the most recent openchrome doctor diagnostic report from cache.
- `oc_evidence_bundle` — Capture a snapshot of the current page state (DOM, screenshot, network slice, console, perceptual hash) and write it to a bundle directory.
- `oc_gate_inspect` — Detect whether the current tab is gated (CAPTCHA, SSO redirect, paywall, 2FA prompt).
- `oc_get_connection_info` — Get connection configuration for a web AI host (Claude Web, ChatGPT, Gemini, or custom).
- `oc_journal` — Query the tool call journal.
- `oc_journal_compact` — Compress a sliding window of journal entries into a compact model-friendly summary.
- `oc_lane_close` — Close a task-scoped browser lane and its lane-owned targets without closing unrelated task tabs.
- `oc_lane_create` — Create a task-scoped browser lane on existing SessionManager worker/target primitives.
- `oc_lane_get` — Fetch one task-scoped browser lane including live target ids and counters.
- `oc_lane_list` — List task-scoped browser lanes for a task.
- `oc_normalize_action` — Validate and normalize a near-valid browser/computer action payload without executing it.
- `oc_observe` — Deterministic, numbered list of actionable elements on the page.
- `oc_open_host_settings` — Open the MCP connector settings page for a web AI host in the default browser.
- `oc_output_fetch` — Redeem an output handle returned by a large-output tool (read_page, crawl, network, extract_data, oc_evidence_bundle).
- `oc_performance_analyze` — Drill into one named insight from a trace captured by oc_performance_insights.
- `oc_performance_insights` — Capture a CDP performance trace and return named insights (LCPBreakdown, DocumentLatency, RenderBlocking, CLSCulprits, LongTasks, ThirdParties).
- `oc_policy` — Inspect deterministic OpenChrome safety policy.
- `oc_progress_status` — Read-only diagnostics for whether the current OpenChrome session appears to be progressing, stalling, or stuck.
- `oc_query` — Resolve a semantic element query into stable refs for interaction workflows.
- `oc_reap_orphans` — Manually sweep and terminate orphaned OpenChrome-managed Chrome processes.
- `oc_reflect` — Create, get, or list structured task-failure reflection artifacts.
- `oc_run_events` — Return recent events for an opt-in OpenChrome run ledger.
- `oc_run_finish` — Finish an opt-in OpenChrome run ledger with a terminal, needs_user_input, or needs_strategy_change status.
- `oc_run_start` — Start an opt-in OpenChrome run ledger.
- `oc_run_status` — Return the current status and summary for an opt-in OpenChrome run ledger.
- `oc_session_resume` — Restore working context after context compaction.
- `oc_session_snapshot` — Save browser state snapshot for context recovery after compaction.
- `oc_skill_export` — Export an opt-in codegen replay artifact written by --codegen.
- `oc_skill_recall` — Retrieve skills from the JSON skill memory store for a given domain.
- `oc_skill_record` — Record a skill (domain, name, steps, contract_id) into the JSON skill memory store.
- `oc_stop` — Shut down OpenChrome and close Chrome.
- `oc_task_cancel` — Request cancellation of a background task.
- `oc_task_finish` — Finish a host-driven task envelope as completed, failed, or cancelled.
- `oc_task_get` — Fetch a single task by task_id.
- `oc_task_list` — List background tasks in the ledger.
- `oc_task_run_checkpoint` — Write a compact caller-provided checkpoint summary for a non-terminal TaskRun and return the checkpoint metadata.
- `oc_task_run_complete` — Enter a terminal TaskRun state (COMPLETED, FAILED, or CANCELLED).
- `oc_task_run_get` — Read a TaskRun meta record and optionally its event log.
- `oc_task_run_list` — List recent TaskRuns sorted by created_at descending.
- `oc_task_run_needs_help` — Move a non-terminal TaskRun to NEEDS_HELP with a secret-safe reason, optional resume hint, cursor, and evidence pointer.
- `oc_task_run_start` — Start an opt-in goal-level TaskRun.
- `oc_task_run_update` — Update a non-terminal TaskRun with progress, item results, cursor, evidence, or explicit NEEDS_HELP resume back to RUNNING.
- `oc_task_start` — Create a task-level browser harness envelope, or launch a long-running tool as a background task.
- `oc_task_update` — Update a task envelope phase or note.
- `oc_task_wait` — Block until the task reaches a terminal state (COMPLETED / FAILED / CANCELLED) or timeout_ms elapses.
- `oc_vitals` — Collect a read-only Web Vitals snapshot from the current page without adding page scripts or package dependencies.
- `page_content` — Get HTML content from page or element.
- `page_pdf` — Generate PDF from page.
- `page_reload` — Reload the current page.
- `page_screenshot` — Save page screenshot to file or return as base64.
- `performance_metrics` — Get page performance metrics.
- `query_dom` — Query DOM elements via CSS selector or XPath.
- `read_page` — Get page as DOM, accessibility tree (ax), CSS diagnostics, semantic summary, or clean Markdown (article-shaped).
- `request_intercept` — Intercept network requests (log, block, modify).
- `tabs_close` — Close one or more tabs by tabId, tabIds, or workerId.
- `tabs_context` — Get session tab IDs grouped by worker.
- `tabs_create` — Create a new tab with URL.
- `user_agent` — Set or reset browser user agent.
- `validate_page` — Composite health check: navigate, wait, capture console errors, return structured summary (title, errors, interactive count, body sample).
- `vision_find` — Find elements using vision-based screenshot analysis.
- `wait_for` — Wait for a condition.
- `worker` — Manage workers.

## crawl

- `batch_execute` — Execute JS across multiple tabs in parallel.
- `batch_paginate` — Extract content from paginated viewers in one call.
- `crawl` — Recursively crawl a website via BFS.
- `crawl_cancel` — Mark a crawl job as cancelled.
- `crawl_sitemap` — Crawl a website using its sitemap.xml.
- `crawl_start` — Initialise a resumable crawl job.
- `crawl_status` — Advance a crawl job by up to `advance` pages (default 5, env OC_CRAWL_ADVANCE_DEFAULT) and return current state.
- `worker_complete` — Mark a worker as complete with final results.
- `worker_update` — Report worker progress to the orchestration scratchpad.

## profile

- `list_profiles` — List available Chrome profiles with names and directory IDs.
- `oc_profile_status` — Check browser profile type and capabilities.

## recording

- `oc_recording_export` — Export a recording as JSON or a self-contained HTML report.
- `oc_recording_list` — List available session recordings, newest first.
- `oc_recording_start` — Start a new session recording.
- `oc_recording_status` — Report whether session recording is active, including trajectory bundle metadata when enabled.
- `oc_recording_stop` — Stop the active session recording and finalize it to disk.

## storage

- `cookies` — Manage browser cookies (get, set, delete, clear).
- `storage` — Manage browser localStorage and sessionStorage.

## totp

- `oc_totp_generate` — Generate a current TOTP 2FA code for a domain.

## workflow

- `execute_plan` — Execute a cached plan by ID, bypassing per-step LLM calls.
- `workflow_cleanup` — Clean up workflow resources (workers, tabs, scratchpads).
- `workflow_collect` — Collect and aggregate results from all workers after completion.
- `workflow_collect_partial` — Collect results from completed workers without waiting for all to finish.
- `workflow_init` — Initialize a workflow with multiple isolated workers for parallel browser ops.
- `workflow_status` — Get current workflow status and worker states.
