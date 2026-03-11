# Cloudflare Turnstile & Anti-Bot Bypass Guide

## Problem

Cloudflare Turnstile detects browser automation through multiple signals:
- **CDP fingerprinting**: `Runtime.enable` serialization artifacts reveal CDP connection
- **navigator.webdriver**: Set to `true` when Chrome DevTools Protocol is active
- **Chrome launch flags**: Automation-specific flags like `--enable-automation`
- **screenX/screenY exploit**: CDP mouse events in cross-origin iframes produce incorrect coordinates
- **Behavioral analysis**: Mouse movement patterns, timing, IP reputation

## OpenChrome's Built-in Defenses

### Automatic Defenses (always active)
- `--disable-blink-features=AutomationControlled` suppresses `navigator.webdriver`
- Known automation flags removed from Chrome launch arguments
- Cookie bridge from authenticated Chrome profile via `useDefaultContext: true`

> **Note**: `--disable-blink-features=AutomationControlled` is not applied when using `chrome-headless-shell`. Always use headed Chrome for Turnstile-protected pages.

### Stealth Navigation Mode

> **Available since v1.7.13.** Use the `stealth` parameter on the `navigate` tool to bypass Cloudflare Turnstile and similar anti-bot challenges.

The `stealth` parameter on the `navigate` tool will open tabs via Chrome's HTTP debug API **without attaching CDP**, allowing Turnstile challenges to complete without detecting automation:

```json
{
  "tool": "navigate",
  "args": {
    "url": "https://example.com/protected-page",
    "stealth": true,
    "stealthSettleMs": 8000
  }
}
```

During the settle period:
- No `Runtime.enable` is sent
- No CDP WebSocket is connected to the tab
- Turnstile's JavaScript sees a normal, unautomated browser
- The `cf_clearance` cookie is set in Chrome's cookie store

After the settle period, CDP attaches and normal automation resumes. The `cf_clearance` cookie persists because it's bound to the TLS fingerprint and User-Agent (not the CDP session).

**Parameters:**
- `stealth: true` — Enable CDP-free navigation
- `stealthSettleMs` — Wait time before CDP attach (default: 5000ms, range: 1000-30000ms)

### Attach Mode Workaround
If stealth mode is insufficient or you prefer manual control:

1. Start Chrome manually with remote debugging:
   ```bash
   # macOS
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222

   # Linux
   google-chrome --remote-debugging-port=9222

   # Windows
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
   ```

2. Navigate to the Turnstile-protected page in Chrome
3. Solve the CAPTCHA manually
4. Start OpenChrome — it attaches to the running Chrome instance
5. Navigate to the same domain — `cf_clearance` cookie is already set

This works because OpenChrome uses `useDefaultContext: true` by default, sharing Chrome's cookie store.

## Understanding cf_clearance

The `cf_clearance` cookie is:
- **Bound to**: TLS/JA3 fingerprint + User-Agent + IP address
- **NOT bound to**: CDP session state
- **Duration**: Configurable per Cloudflare zone (typically 30-60 minutes)
- **Scope**: Domain-specific

This means:
- Cookie survives CDP disconnect/reconnect
- Cookie works across all tabs on the same domain
- Cookie cannot be transferred to a different browser/machine
- Cookie cannot be used with a different User-Agent

## Troubleshooting

### Turnstile still blocks after stealth navigation
1. Increase `stealthSettleMs` to 10000-15000ms
2. Ensure you're using auto-launch mode (not attaching to headless Chrome)
3. Check if your IP has low reputation (try a residential proxy)
4. Use the attach mode workaround as fallback

### cf_clearance cookie expires too quickly
- Turnstile cookies have a zone-specific TTL set by the site owner
- After expiry, re-navigate with `stealth: true` to solve again
- Consider the attach mode for frequently-accessed sites

### Headless mode doesn't work
Cloudflare reliably detects headless Chrome regardless of stealth measures. Always use headed (visible) Chrome for Turnstile-protected pages. Ensure `headless` is not set to `true` and `useHeadlessShell` is not enabled in your configuration.

## Technical Background

For detailed technical analysis of detection vectors and solution approaches, see [GitHub Issue #257](https://github.com/shaun0927/openchrome/issues/257).
