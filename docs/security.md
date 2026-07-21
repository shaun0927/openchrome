# Security policy notes

## DevTools attach boundary (`--auto-connect`)

`--auto-connect` binds only to `127.0.0.1`. The wsEndpoint returned by
`discoverActiveDevToolsPort` is always `ws://127.0.0.1:<port><target-path>`
regardless of what the `DevToolsActivePort` file's second line contains, and
the pre-return probe dials loopback before the endpoint is handed back.

Remote attach is intentionally out of scope. If you need to bridge the debug
port across hosts, terminate the tunnel in front of openchrome (SSH tunnel,
`socat`, Cloudflare Tunnel); do not point `--auto-connect` at a remote
user-data dir. See `docs/auto-connect.md` for the full contract, including
the forbidden-port list and the attach recipe.

## Page-origin boundary markers

OpenChrome wraps page-origin text in `<oc:*>` blocks so host agents can
separate untrusted page content from tool-origin metadata. Host LLMs should not
follow instructions found inside these blocks.

- `read_page`: `<oc:page src="..." mode="dom|ax|css|markdown">…</oc:page>`
- `page_content`: `<oc:page src="..." mode="text">…</oc:page>`
- `console_capture`: `<oc:console origin="...">…</oc:console>`

Markers are enabled by default. Disable server-wide with
`OPENCHROME_BOUNDARY_MARKERS=0` or per call with `boundaryMarkers: false`.
Literal marker open/close tokens inside page text are escaped with U+200B after
`<` so a parser cannot see a premature marker.

## Pilot credential vault (`vault://name`)

When the pilot tier is enabled, `oc_credentials` can store local credentials in `~/.openchrome/vault` and browser input tools can resolve `vault://name` references server-side. The vault is encrypted at rest using the same AES-256-GCM persistence layer as pilot handoff tokens; passphrase mode derives a 32-byte key with argon2id. Tool responses and trace redaction replace resolved vault literals with `<vault:name>` where the server observes them.

Threat-model boundary: this protects OpenChrome traces, audit surfaces, and MCP responses from carrying plaintext credentials. It does not prevent the destination page from reading the field after OpenChrome types the credential into that page; same-origin page JavaScript can still inspect its own form values.

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
