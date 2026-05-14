# Topic survey recipe

## When to use
Use this when you need a fast, repeatable survey of several pages from one public site before the host LLM writes a short brief. It keeps OpenChrome as the deterministic browser/tool layer and leaves synthesis to the MCP host.

## Tools used
- `mcp__openchrome__crawl_sitemap`
- `mcp__openchrome__extract_data`
- `mcp__openchrome__validate_page`
- `mcp__openchrome__batch_execute`

**Public fixture:** `https://example.com/`

## Run it
Run this with `mcp__openchrome__batch_execute` from any existing OpenChrome tab. Replace `active-tab-id` only if your MCP client requires the current tab id explicitly.

```json
{
  "tasks": [
    {
      "tabId": "active-tab-id",
      "workerId": "topic-survey-example",
      "timeout": 10000,
      "script": "location.href = 'https://example.com/'; await new Promise(resolve => setTimeout(resolve, 1000)); return { url: location.href, title: document.title, heading: document.querySelector('h1')?.textContent?.trim() ?? '', linkCount: document.querySelectorAll('a').length, paragraphs: Array.from(document.querySelectorAll('p')).map(p => p.textContent?.trim()).filter(Boolean).slice(0, 3) };"
    }
  ],
  "concurrency": 1,
  "failFast": true
}
```

## Expected outcome
- Response contains `summary.total: 1` and `summary.failed: 0`.
- The first task result has `data.title` matching `/Example Domain/i`.
- `data.heading` is `Example Domain` and `data.linkCount` is at least `1`.

Observed fixture check: 2026-05-14, OpenChrome 1.11.x, `https://example.com/` returned title `Example Domain`.

## Customisation
- Swap the fixture URL for a sitemap-backed product or docs home page to survey the page shell before deeper crawls.
- Increase the paragraph slice from `3` to `10` when the host needs more context.
- Follow up with `crawl_sitemap` and `extract_data` for multi-page structured extraction once the landing page is validated.
