# `oc_diff`

`oc_diff` compares two evidence bundle IDs or absolute bundle paths and returns
a structured, deterministic fact for selected kinds:

```json
{
  "before": "<bundle-id-or-path>",
  "after": "<bundle-id-or-path>",
  "kinds": ["dom", "screenshot", "url", "console", "network"]
}
```

Default `kinds` are all five kinds. Bundle IDs resolve under the default
evidence root (`/tmp/openchrome-evidence` on typical systems); absolute paths
are accepted for tests and local diagnostics.

## DOM paths and normalization

DOM diffs use simplified tag-index paths such as
`/html[1]/body[1]/div[2]/button[1]`. IDs are intentionally not used in paths so
framework-generated IDs do not destabilize output.

Before diffing, DOM is normalized by:

- replacing ISO-8601 timestamps with `<TS>`;
- replacing CSRF/data-nonce/data-rid token attributes with `<TOKEN>`;
- replacing React/Vue generated IDs with `<GEN>`;
- sorting class-name sets alphabetically;
- ignoring script/style text content while still preserving element presence.

## Screenshot, console, and network

Screenshot comparison uses existing `phash.json` files and reports Hamming
distance, total bits, and ratio. It does not perform pixel-level image diffing.
Console and network comparisons report entries newly present in the `after`
bundle, grouped by console level or HTTP status.
