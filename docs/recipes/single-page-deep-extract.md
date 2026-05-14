# Single-page deep extract recipe

## When to use
Use this when one high-value page contains the facts you need and the host LLM only needs a bounded, structured snapshot. It is a deterministic alternative to asking the model to browse freely.

## Tools used
- `mcp__openchrome__read_page`
- `mcp__openchrome__extract_data`
- `mcp__openchrome__oc_assert`
- `mcp__openchrome__batch_execute`

**Public fixture:** `https://news.ycombinator.com/`

## Run it
Run this with `mcp__openchrome__batch_execute` from any existing OpenChrome tab. Replace `active-tab-id` only if your MCP client requires the current tab id explicitly.

```json
{
  "tasks": [
    {
      "tabId": "active-tab-id",
      "workerId": "hn-front-page-extract",
      "timeout": 15000,
      "script": "location.href = 'https://news.ycombinator.com/'; await new Promise(resolve => setTimeout(resolve, 2000)); const rows = Array.from(document.querySelectorAll('.athing')).slice(0, 5).map(row => ({ id: row.getAttribute('id'), title: row.querySelector('.titleline a')?.textContent?.trim() ?? '', url: row.querySelector('.titleline a')?.getAttribute('href') ?? '' })); return { url: location.href, title: document.title, rowCount: rows.length, rows };"
    }
  ],
  "concurrency": 1,
  "failFast": true
}
```

## Expected outcome
- Response contains `summary.total: 1` and `summary.failed: 0`.
- The first task result has `data.title` matching `/Hacker News/i`.
- `data.rows` contains at least one item with a non-empty `title`.

Observed fixture check: 2026-05-14, OpenChrome 1.11.x, `https://news.ycombinator.com/` returned a front-page title list.

## Customisation
- Replace the CSS selector with a site-specific article/card selector for other list pages.
- Increase the slice from `5` to `20` when the host needs broader coverage.
- Follow up with `oc_assert` against the extracted `rowCount` before using the rows in a report.
