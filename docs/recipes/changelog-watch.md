# Changelog watch recipe

## When to use
Use this to check whether a stable page changed between two observations. It is useful for release notes, docs pages, or policy pages where the host LLM should only summarize after deterministic drift is detected.

## Tools used
- `mcp__openchrome__oc_evidence_bundle`
- `mcp__openchrome__read_page`
- `mcp__openchrome__batch_execute`

**Public fixture:** `https://example.com/`

## Run it
Run this with `mcp__openchrome__batch_execute` from any existing OpenChrome tab. Replace `active-tab-id` only if your MCP client requires the current tab id explicitly.

```json
{
  "tasks": [
    {
      "tabId": "active-tab-id",
      "workerId": "example-com-checksum-a",
      "timeout": 10000,
      "script": "location.href = 'https://example.com/'; await new Promise(resolve => setTimeout(resolve, 1000)); const text = document.body?.innerText ?? ''; let hash = 0; for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0; return { url: location.href, title: document.title, textLength: text.length, checksum: String(hash) };"
    },
    {
      "tabId": "active-tab-id",
      "workerId": "example-com-checksum-b",
      "timeout": 10000,
      "script": "await new Promise(resolve => setTimeout(resolve, 5000)); const text = document.body?.innerText ?? ''; let hash = 0; for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0; return { url: location.href, title: document.title, textLength: text.length, checksum: String(hash) };"
    }
  ],
  "concurrency": 1,
  "failFast": true
}
```

## Expected outcome
- Response contains `summary.total: 2` and `summary.failed: 0`.
- Both task results have `data.title` matching `/Example Domain/i`.
- The second `checksum` equals the first checksum for this static fixture.

Observed fixture check: 2026-05-14, OpenChrome 1.11.x, two reads of `https://example.com/` produced the same body checksum.

## Customisation
- Replace `https://example.com/` with a docs or changelog URL under watch.
- Increase the delay between the two tasks when watching pages with slow client-side rendering.
- Persist the first checksum in the host environment and compare it with a later run for scheduled monitoring.
