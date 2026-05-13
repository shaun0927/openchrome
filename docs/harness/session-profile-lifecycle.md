# Long-running session/profile recovery lifecycle

OpenChrome tracks three related identities during long-running runs:

| Layer | What it represents | Survives server restart? | Survives browser/profile restart? |
| --- | --- | --- | --- |
| Session id | OpenChrome's in-memory grouping of workers and target ids. | Only when the browser targets are still reachable and `oc_session_resume` can remap them. | No; stale targets need a fresh tab/context. |
| Profile identity | Chrome `userDataDir` plus optional `profileDirectory`. This owns cookies, localStorage, IndexedDB, and extensions depending on profile type. | Yes when the same profile is reused. | Persistent/real/explicit profiles can preserve storage; temporary profiles cannot be relied on. |
| Storage-state | Optional OpenChrome storage-state persistence (`OC_PERSIST_STORAGE`, `OC_STORAGE_DIR`). | Yes when enabled and the same storage-state directory is reused. | Yes for persisted state; it does not resurrect closed CDP targets. |
| Target id/tab id | CDP page target captured in `oc_session_snapshot`. | Maybe; exact target ids may be live, remapped by URL, or closed. | No; create a fresh tab for closed targets. |

## Snapshot and resume contract

`oc_session_snapshot` now stores lifecycle metadata with each snapshot:

- `recoverySource`: always `oc_session_snapshot` for these artifacts.
- `profile`: current profile type plus `userDataDir`, `profileDirectory`, and cookie-sync timestamp when available.
- `storageState`: whether storage-state persistence was enabled and the configured directory.
- per-tab metadata: `sessionId`, `workerId`, `targetId`, URL/title, optional `profileDirectory`, and session/worker last activity timestamps.

`oc_session_resume` reads that metadata and separates what can be reused from what cannot:

- `LIVE`: the original target id is still reachable; verify with `read_page` or `tabs_context` before mutating.
- `REMAPPED`: the original target is gone, but another live target with the same URL was found; use the reported current target id.
- `CLOSED`: the target is stale. Open a fresh tab/context with the same URL and profile/storage identity before continuing.

## Recovery policy by restart type

- **Context compaction only:** call `oc_session_resume`; live targets should remain reusable.
- **OpenChrome server restart with Chrome still running:** call `oc_session_resume`; expect a mix of `LIVE`, `REMAPPED`, and `CLOSED` depending on CDP target reachability.
- **Chrome/browser restart:** target ids are stale. Reuse the same `profileDirectory` and storage-state settings, then open fresh tabs for the saved URLs.
- **Temporary profile:** do not assume authenticated cookies/localStorage survive process restart. Use a persistent, real, or explicit profile when auth reuse is required.

## Auth/session reuse guidance

For authenticated tasks, prefer one of these explicit identities:

1. `profileDirectory` on `navigate`/`tabs_create` for a Chrome profile-backed worker.
2. A persistent or explicit `userDataDir` at server startup.
3. Enabled storage-state persistence with a stable `OC_STORAGE_DIR`.

The resume guide intentionally does not embed cookies or storage payloads. It only records bounded identity metadata so an operator can restart with the same profile/storage settings.

## Merge/live verification checklist

1. Start OpenChrome with a stable profile or storage-state directory.
2. Open a tab with `navigate` or `tabs_create`.
3. Run `oc_session_snapshot` and inspect the saved JSON for `lifecycle.profile`, `lifecycle.storageState`, and per-tab session/profile ids.
4. Restart the OpenChrome server while leaving Chrome running, then run `oc_session_resume`.
5. Confirm the guide reports `LIVE`, `REMAPPED`, or `CLOSED` for each saved tab.
6. For every `CLOSED` tab, verify the guide recommends a fresh tab/context and preserving profile/storage identity.
