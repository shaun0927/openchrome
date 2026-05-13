# Security policy notes

## Host allowlist (`--allow-host` / `OPENCHROME_ALLOW_HOSTS`)

OpenChrome is default-allow. If no allowlist is configured, existing behavior is unchanged.

Set a comma-separated allowlist to restrict browser navigation entry points:

```bash
openchrome serve --allow-host example.com,*.github.com
# or
OPENCHROME_ALLOW_HOSTS=example.com,*.github.com openchrome serve
```

When an allowlist is active:

- Only `http:` and `https:` URLs are eligible.
- Exact patterns such as `example.com` match only that host.
- Leading wildcards such as `*.github.com` match subdomains (`api.github.com`) but not the apex (`github.com`).
- IDN inputs are normalized to Punycode before comparison.
- IP literals must be listed exactly.
- `file:`, `data:`, `javascript:`, `chrome:`, `chrome-extension:`, and `view-source:` are blocked with `reason: "scheme-not-allowed"`.

Blocked navigation attempts are surfaced as structured facts:

```json
{
  "blocked": true,
  "reason": "host-not-allowed",
  "attemptedUrl": "https://attacker.example/",
  "matchedPattern": null
}
```

The existing `--blocked-domains` blocklist remains supported. If both policies are configured, the allowlist is checked first, then the blocklist.
