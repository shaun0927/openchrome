# Observe, pause and resume browser input

`oc_browser_control` exposes current operation facts and a small human input lease. The host still owns the task, account choice and decision to continue.

## Start without keeping a blank window open

From a directory where the candidate package is installed, start its standalone MCP entrypoint with an isolated browser:

```bash
node ./node_modules/openchrome-mcp/dist/index.js --headless --launch-mode isolated --no-auto-elect
```

Browser startup remains lazy: listing tools does not launch Chrome; the first browser operation does. Explicit headless mode prevents automatic headed fallback. The acceptance harness tests this standalone configuration; attached user browsers and shared broker deployment require their corresponding configuration.

## Inspect a background tab

Call `oc_browser_control` with `{"action":"status","tabId":"<managed target>"}`. It returns active tools, recent completion times, pending writes and the current phase. Arguments, cookies, page text and URL query strings are not included. Use existing `read_page` and `page_screenshot` tools for page evidence.

These are in-memory observations, not a durable execution journal. History is bounded; running operations are counted separately. A tool can return an uncertain cancellation outcome while its already-dispatched CDP command remains active.

## Let a person change the page

1. Call `pause` for the target. Keep the returned `lease` and logical `sessionId`.
2. Poll `status` until `phase` is `human`. While `draining`, an earlier tracked write is still pending. New writes to that target are refused before dispatch. Writes with unknown scope, including arbitrary JavaScript, are conservatively blocked while any target is held.
3. For an already visible browser, `pause` with `reveal:true` explicitly brings the tab forward once drained. Headless Chrome is not restarted automatically. Its response describes the visibility limitation.
4. After the person finishes, call `resume` with the lease and exact `expectedUrl`. Optionally supply a visible CSS `selector` and exact trimmed `expectedText`, such as the account identifier displayed by the site.
5. A mismatch keeps the lease paused. Successful resume discards old element references; read the page again before acting.

`human` means tracked tool handlers and their tracked CDP commands have drained. It does **not** freeze website timers, background fetches or JavaScript deliberately started without awaiting its completion. Use site-specific checks where these matter.

Read-only observations remain available during a pause. Independent target writes can continue. Control requests themselves bypass write admission so status and resume cannot deadlock behind their own lease.

Idle and memory-pressure session cleanup preserve held targets. HTTP transport deletion keeps the held logical browser session and its tenant binding. Reconnect using that logical session within the same authorized tenant, inspect status and resume explicitly. A process restart, browser crash or explicit target/session shutdown ends this in-memory control boundary; do not infer that the old lease survived.

## Check the account before continuing

`verify` accepts the same URL and optional element conditions without acquiring or releasing a lease. The selector checks the first matching element for visibility. Exact URL matching includes the query and fragment, although those values are not echoed.

The result deliberately says `authentication: "unverified"`: a caller-supplied page condition is evidence chosen by the host, not proof that every subsequent server request is authorized. Reuse browser profiles and context-specific storage snapshots; treat expired sessions as requiring explicit login. Restoration fills absent state and does not overwrite newer live cookies or local storage.

## Handle cancellation and uncertain writes

Send the standard MCP `notifications/cancelled` notification with the original `requestId`. IDs are scoped to the transport session. Pre-dispatch interruption reports `execution: "not_started"`; interruption after dispatch reports `execution: "unknown"` and `retryAllowed: false`.

Cancellation stops further cooperative/CDP admission. It cannot roll back an already sent click, request or script. Connection failures on mutating tools are not automatically replayed. Inspect page state or an independent server receipt before deciding whether another attempt is appropriate.

## Reproduce the package checks

From a checkout with dependencies installed and Chrome available:

```bash
npm run build
npm run harness:frontier -- --runtime-contract --confirmed-scope
```

To test an installed package outside the checkout, add `--entry` pointing to its `dist/index.js` and `--artifact` pointing to its tarball. The harness uses an isolated home/profile, four fixture accounts and authenticated server receipts. On interactive Windows it also records foreground process transitions without window titles. Reports explicitly mark unavailable foreground observation as inconclusive.

To check upgrade continuity, start with a prior tarball installed in a dedicated temporary prefix, pass its entry and artifact, and add `--upgrade-package <candidate.tgz> --upgrade-prefix <temporary-prefix>`. The harness saves state, stops the old browser, installs the candidate and requires authenticated probes from all four restored contexts without calling the login endpoint again.

Fixture checks are not external-site success rates, real-person usability testing or long-running memory-leak certification. Warm `tabs_context` measurements are reported per independent process trial; repeated calls within a process are not independent trials.
