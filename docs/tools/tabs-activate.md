# `tabs_activate`

`tabs_activate` is an explicit Chrome tab foreground operation for workflows
whose behavior depends on page visibility, focus, background throttling, lazy
rendering, media, canvas, or keyboard delivery.

The tool is never called automatically by `navigate`, `read_page`, `interact`,
`batch_execute`, or other browser tools. It is a tier-2 tool on the full
surface and is omitted from the default `--minimal` surface.

## Call

```json
{
  "tabId": "<target id>",
  "workerId": "<optional worker id>",
  "windowForeground": "cdp-only"
}
```

OpenChrome validates the session, optional worker, and target ownership before
activation. Authorized requests are ordered through the single broker owner so
concurrent clients cannot race the browser's foreground target.

## Verification

Each attempt sends CDP `Target.activateTarget`, then reads both
`document.visibilityState` and `document.hasFocus()` within the normal tool
deadline. In `cdp-only` mode, verified activation requires observed
`visibilityState === "visible"`; document focus is reported separately.

The result records the attempt count, whether activation was sent, visibility,
focus, the CDP path, and whether a newer activation request superseded this
one. A CDP acknowledgement without visible document evidence is returned as
`inconclusive`, not success.

## Foreground Safety

`windowForeground` currently accepts only `cdp-only`. OpenChrome does not run
AppleScript, PowerShell, window-manager commands, or application-name guesses.
Attach mode therefore never foregrounds an unrelated user Chrome process.
