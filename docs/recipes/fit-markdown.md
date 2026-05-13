# fit_markdown filters

Use deterministic `fit_markdown` filtering when markdown output contains
boilerplate that wastes host context. The feature is opt-in; existing markdown
and markdown-clean defaults remain unchanged.

## read_page

```json
{
  "tabId": "tab-1",
  "mode": "markdown",
  "contentFilter": "prune",
  "returnRaw": true,
  "returnFit": true
}
```

For query-aware filtering:

```json
{
  "tabId": "tab-1",
  "mode": "markdown",
  "contentFilter": "bm25",
  "query": "enterprise pricing",
  "returnFit": true
}
```

## crawl / crawl_sitemap

```json
{
  "url": "https://example.com",
  "output_format": "markdown-clean",
  "content_filter": "prune",
  "return_raw": false,
  "return_fit": true
}
```

Each filtered response includes `filter` metrics: raw/fit character counts,
reduction ratio, sections seen/kept, filter type, and query when applicable.
`bm25` requires a non-empty query and fails clearly instead of silently falling
back.
