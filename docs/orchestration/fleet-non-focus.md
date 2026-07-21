---
doc_kind: project-material
status: working
version: 2026-07-21_v1
canonical_path: /home/elite/projects/tools/references/openchrome-fork-b2/docs/orchestration/fleet-non-focus.md
---

# Fleet lease · non-focus (background) driving

`FleetLease` (src/session/fleet-lease.ts) lets a worker be marked
`background: true`. The intent is that CDP commands the driver
issues against that worker must not raise the tab or the browser
window to focus — every desktop OS treats focus activation as an
event, and stealth vendors fingerprint it.

## Command allowlist (safe for background)

- Target lifecycle · `Target.attachToTarget`, `Target.detachFromTarget`,
  `Target.createTarget` (only with `background: true` param on Chromium
  builds that support it).
- Page state · `Page.reload`, `Page.navigate` (does not steal focus
  when target is background), `Page.setLifecycleEventsEnabled`.
- DOM / Runtime evaluation · `Runtime.evaluate`, `DOM.querySelector`,
  `DOM.getBoxModel`, `Accessibility.getFullAXTree`.
- Network · `Network.enable`, `Network.setCacheDisabled`,
  `Network.getCookies`.
- Storage · `Storage.setCookies`, `IndexedDB.*`, `CacheStorage.*`.
- Screenshotting `Page.captureScreenshot` with `fromSurface: true`
  reads the compositor surface without a focus change.

## Command denylist (raise focus)

- `Page.bringToFront` — the whole point of background mode is to
  avoid this call. Refuse it in the background driver's dispatcher.
- `Input.dispatchMouseEvent` at coordinates covered by another
  window — on many OSes this activates the tab. Prefer
  `Runtime.evaluate` synth-clicks via `element.click()` for
  background tabs.
- `Input.dispatchKeyEvent` on macOS — depending on the target's
  frame chain, key events may raise the window. Use
  `Runtime.evaluate` to dispatch key events synthesised in-page.
- `Emulation.setFocusEmulationEnabled(false)` toggled at runtime
  can force focus recovery paths in web content — leave it on the
  default the tab was created with.

## Acquiring a background lease

```ts
import { FleetLease } from 'openchrome-mcp/dist/session/fleet-lease';

const pool = new FleetLease();
pool.register('worker-fg-1');
pool.register('worker-bg-1', { background: true, label: 'crawler' });
pool.register('worker-bg-2', { background: true, label: 'crawler' });

// Foreground driver — will only see worker-fg-1
const fg = pool.acquire({ sessionId: 'user-1', ttlMs: 60_000 });

// Background driver — will only see worker-bg-1 or worker-bg-2
const bg = pool.acquire({
  sessionId: 'crawler-1', ttlMs: 60_000, preferBackground: true,
});
```

The lease primitive enforces the flag by never handing a background
worker to a caller that did not set `preferBackground: true`, and
vice versa. Callers cannot cross the lane by accident.

## Sweep cadence

Leases carry an expiry (`expiresAt`) so a crashed driver does not
starve the pool. Callers arm a periodic timer that calls
`pool.sweep()` — a good default is `ttlMs / 4`. Sweep and acquire
are race-free because the pool serialises on the JS single thread.

## Origin credit

Idiom from trycua's Fleet Lease primitive (MIT). Clean-room
implementation in `src/session/fleet-lease.ts`.
