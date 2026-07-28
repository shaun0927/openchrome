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

## resumable crawl_start / crawl_status

Persist the same Markdown projection contract when the host needs bounded,
resumable progress:

```json
{
  "url": "https://example.com",
  "output_format": "markdown-clean",
  "content_filter": "prune",
  "return_raw": true,
  "return_fit": true
}
```

Use the returned `jobId` to advance and read pages:

```json
{
  "jobId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "advance": 5,
  "includePages": true
}
```

Filtered pages use `fit_markdown` as canonical `content`. Requested raw and fit
aliases are returned by `crawl_status` without storing duplicate copies when an
alias is identical to `content`.

Projection options are ignored unless `output_format` is `markdown-clean`.
Because raw Markdown can contain authenticated page content, `return_raw: true`
does not read or write the shared `public` cache. Set `cache_scope` to `session`
when raw projection caching is required.

Resumable queries are limited to 2,048 characters. Credential-shaped query
material is rejected instead of being written to the durable job log.

Each filtered response includes `filter` metrics: raw/fit character counts,
reduction ratio, sections seen/kept, filter type, and query when applicable.
`bm25` requires a non-empty query and fails clearly instead of silently falling
back.
