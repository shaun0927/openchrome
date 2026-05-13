# Crawl content cache modes

`crawl`, `crawl_sitemap`, and resumable crawl jobs (`crawl_start`/`crawl_status`)
support an explicit, default-off URL content cache for repeated public crawl
workloads.

Arguments:

- `cache_mode`: `disabled` (default), `enabled`, `read_only`, `write_only`, or `bypass`
- `cache_ttl_ms`: optional max age for `enabled`/`read_only` hits
- `cache_scope`: `public` (default) or `session`

Mode semantics:

| Mode | Read existing cache | Write fetched result | Fetch when absent/stale |
| --- | --- | --- | --- |
| `disabled` | no | no | yes |
| `enabled` | yes | yes | yes |
| `read_only` | yes | no | yes |
| `write_only` | no | yes | yes |
| `bypass` | no | yes, overwrites | yes |

Entries are stored under `~/.openchrome/cache/crawl/` by default. Set
`OPENCHROME_CRAWL_CACHE_DIR` to override the directory. Each entry records schema
version, creation time, source URL, final URL, content length, cache key, page
content, and discovered links where applicable. Cleanup is invoked only during
cache writes; there is no background timer.

Public-scope writes are skipped for obvious authenticated/session-sensitive
pages such as account, dashboard, billing, admin, settings, checkout, cart,
profile, and login paths/titles, or content containing password/token-like form
signals. Skipped writes still return the fetched page with
`page.cache.write_skipped_reason`.

Default behavior is unchanged: omitting `cache_mode` produces no cache metadata
and writes no files.
