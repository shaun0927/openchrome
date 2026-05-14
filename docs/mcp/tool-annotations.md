# Tool Annotations

This document is the **human-readable mirror** of
`src/types/tool-annotations.ts` (the runtime source of truth). Every tool that
OpenChrome registers via `MCPServer.registerTool()` MUST appear here with an
explicit annotation row — there are no defaults.

If you add a tool, update both this table and `tool-annotations.ts` in the same
PR. The unit test in `tests/unit/tool-annotations.test.ts` enforces that every
tool file declares `annotations: TOOL_ANNOTATIONS.<name>` and that every
registered name has an entry in the table.

## Semantics (recap)

Annotations are **per-tool, worst-case** — they describe the most
destructive / least pure behavior the tool can exhibit across **all** valid
input combinations, not the typical or default behavior.

| Hint                | Meaning                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `readOnlyHint`      | `true` iff **no** valid input mutates Chrome state, the file system, the recording journal, skill memory, or any external resource |
| `destructiveHint`   | `true` iff **at least one** valid input deletes data, terminates processes, mutates persisted profile state, or blocks network    |
| `idempotentHint`    | `true` iff for **every** valid input `X`, calling with `X` twice has the same observable effect as calling once                   |
| `openWorldHint`     | `true` iff **at least one** valid input triggers network egress beyond loopback                                                    |

A tool that can be either read-only or destructive depending on `action` is
annotated as **not** read-only and **destructive** (worst case).

A tool that triggers external requests, writes new files, or starts new
processes is treated as **not** idempotent, even if a specific subset of its
actions would be idempotent in isolation.

## Canonical table

Categories below are documentation-only — the runtime source is
`TOOL_ANNOTATIONS` in `src/types/tool-annotations.ts`.

### Pure reads — `{ readOnly:T, destructive:F, idempotent:T, openWorld:F }`

| Tool                       | Notes                                                |
| -------------------------- | ---------------------------------------------------- |
| `inspect`                  | Query-focused page state extraction                  |
| `query_dom`                | Read-only DOM query                                  |
| `find`                     | Element discovery                                    |
| `read_page`                | Page text/title extraction                           |
| `page_content`             | HTML content read                                    |
| `tabs_context`             | Tab list snapshot                                    |
| `list_profiles`            | Chrome profile enumeration                           |
| `performance_metrics`      | Page performance read                                |
| `oc_vitals`                | Web Vitals performance read                          |
| `oc_profile_status`        | Profile status read                                  |
| `oc_get_connection_info`   | Server/Chrome connection metadata read               |
| `oc_connection_health`     | Health probe                                         |
| `oc_skill_recall`          | Read skill memory                                    |
| `vision_find`              | Read-only image-based discovery                      |
| `oc_assert`                | Single-call contract verifier (read-only)            |
| `oc_recording_list`        | List existing recordings                             |
| `workflow_status`          | Workflow read                                        |
| `workflow_collect`         | Collect previously-completed results                 |
| `workflow_collect_partial` | Collect partial in-progress results                  |
| `wait_for`                 | Pure wait on observable state                        |
| `oc_doctor_report`        | Cached doctor report read                            |
| `oc_devtools_url`         | DevTools URL metadata read                           |
| `oc_diff`                 | Evidence bundle diff read                            |
| `oc_context_export`       | Portable context envelope export                     |
| `oc_observe`              | Deterministic actionable-element enumeration         |
| `oc_performance_analyze`  | Analyze an existing performance trace                |
| `oc_progress_status`       | Session progress diagnostics                         |

### Network egress — `{ readOnly:F, destructive:F, idempotent:F, openWorld:T }`

| Tool             | Notes                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `navigate`       | Loads a URL — fires real network requests                                                                        |
| `page_reload`    | Re-fetches the page                                                                                              |
| `crawl`          | Visits N pages from a seed                                                                                       |
| `crawl_sitemap`  | Visits N pages from a sitemap                                                                                    |
| `validate_page`  | Calls `smartGoto`, may create a new tab, waits on live page state — open-world, mutating, non-idempotent         |
| `batch_paginate`          | Presses keys / clicks / scrolls; `url` strategy creates tabs and navigates to generated URLs — worst-case egress |
| `oc_performance_insights` | Captures performance data and may reload/navigate to a URL                                                       |
| `workflow_init`           | Performs `dnsResolve` and worker calls `page.goto` to non-loopback URLs                                          |

### Network egress + destructive — `{ readOnly:F, destructive:T, idempotent:F, openWorld:T }`

These tools combine network egress with destructive worst-case capability. They are flagged DESTRUCTIVE because, under the per-tool worst-case rule, at least one valid input causes deletion, network-request blocking, or terminates observable state — even though they are not destructive on every call.

| Tool                | Notes                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `network`           | `Network.emulateNetworkConditions({ offline: true, ... })` blocks every request — destructive against network                                                                  |
| `request_intercept` | Installs request-blocking rules; see [`request-intercept-presets.md`](request-intercept-presets.md) for #861 bandwidth presets                                                 |
| `javascript_tool`   | Arbitrary JS via `Runtime.evaluate` — worst case includes `document.cookie = ''`, `window.close()`, `fetch()` to any origin, or invoking a sibling destructive tool            |
| `batch_execute`     | Batch dispatcher that can invoke arbitrary tools and evaluate arbitrary JS expressions — worst case is its worst sub-call                                                      |
| `act`               | NL action router — click can trigger irreversible browser-side mutations (Delete-account, payment confirmation, etc.)                                                          |
| `oc_proxy_hook`     | Pilot proxy hook can alter network/proxy behavior and affect external requests                                                                                                 |
| `execute_plan`      | Resolves arbitrary tool names at runtime; worst-case set includes destructive tools and non-loopback navigations                                                               |

### Destructive — `{ readOnly:F, destructive:T, idempotent:F, openWorld:F }`

| Tool                | Notes                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `cookies`           | Can delete one or all cookies                                        |
| `storage`           | Can clear localStorage / sessionStorage / IndexedDB                  |
| `tabs_close`        | Closes tab (terminates state)                                        |
| `oc_stop`           | Terminates running sessions and Chrome processes                     |
| `oc_reap_orphans`   | Kills orphaned Chrome processes                                      |
| `oc_recording_stop` | Terminates a recording session                                       |
| `workflow_cleanup`  | Removes workflow state                                               |
| `worker_complete`   | Terminates a worker                                                  |
| `console_capture`   | `clear` action deletes buffered logs; `start`/`stop` mutate capture state |
| `memory`            | Validate-prune path deletes memory entries                           |

### Mutating (not destructive, no network) — `{ readOnly:F, destructive:F, idempotent:F, openWorld:F }`

| Tool                    | Notes                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| `computer`              | Generic UI action (click/type/scroll)                            |
| `interact`              | Smart interaction primitive                                      |
| `form_input`            | Type into specific input                                         |
| `fill_form`             | Composite form-fill                                              |
| `drag_drop`             | Drag-and-drop                                                    |
| `file_upload`           | Uploads a file from a host path                                  |
| `http_auth`             | Installs HTTP basic-auth credentials                             |
| `user_agent`            | Overrides user-agent                                             |
| `geolocation`           | Overrides geolocation                                            |
| `emulate_device`        | Switches device emulation                                        |
| `tabs_create`           | Opens a new tab (state mutation, not destructive)                |
| `lightweight_scroll`    | Scroll (page state)                                              |
| `oc_skill_record`       | Skill memory write                                               |
| `oc_journal`            | Multi-action — read OR write                                     |
| `oc_session_snapshot`   | Writes snapshot file                                             |
| `oc_session_resume`     | Restores session state                                           |
| `oc_checkpoint`         | Writes a checkpoint                                              |
| `oc_evidence_bundle`    | Writes evidence files                                            |
| `oc_recording_start`    | Begins a recording session                                       |
| `oc_recording_export`   | Writes an export file                                            |
| `oc_copy_to_clipboard`  | Writes to OS clipboard                                           |
| `oc_open_host_settings` | Opens host-OS settings UI                                        |
| `oc_totp_generate`      | Generates a TOTP code (uses persisted secret)                    |
| `page_pdf`              | Renders PDF (writes file)                                        |
| `page_screenshot`       | Captures screenshot (may write file)                             |
| `extract_data`          | Structured-extraction walk (may persist artifacts)               |
| `worker`                | Worker control                                                   |
| `worker_update`         | Worker state update                                              |
| `network_capture_lite`  | Starts/stops passive network capture state                         |
| `network_capture_full`  | Starts/stops passive network capture with body retention options    |
| `oc_context_import`     | Imports cookies/storage/auth context into a tab                     |
| `oc_pilot_run_with_recovery` | Pilot wrapper can invoke a mutating original action plus bounded recovery recipes |

### Virtual / runtime-only

| Tool           | Annotation        | Notes                                                                             |
| -------------- | ----------------- | --------------------------------------------------------------------------------- |
| `expand_tools` | Mutating          | Synthesized inline by `MCPServer.handleToolsList()`; expands the exposed tier set |

## Verification

Run `npm test -- tool-annotations` to verify:
- Every entry has all four hint fields
- The expected-destructive / read-only / open-world sets match the table
- Every tool file declares `annotations: TOOL_ANNOTATIONS.<name>`
- Multi-tool files (`orchestration.ts`, `recording.ts`, `connect.ts`) have the expected number of annotation lines
