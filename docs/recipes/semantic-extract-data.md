# Query-based semantic `extract_data`

Use `extract_data` with `mode: "semantic"` when deterministic JSON-LD,
Microdata, OpenGraph, and CSS heuristics are insufficient but the host LLM can
extract from a small, relevant markdown chunk.

Semantic mode is opt-in. Existing calls without `mode: "semantic"` keep the
normal deterministic path.

## Host-extraction fallback

OpenChrome does not require or default to a server-side extraction LLM. When no
server-side provider is configured, semantic mode returns:

- `semanticProvider: "host"`
- a bounded redacted markdown `chunk`
- `schema` and `query`
- `contentStats`
- `chunkIndex`, `totalChunks`, and `nextStartChar` continuation metadata
- `hostExtraction` instructions for the MCP host

The host can perform extraction, then call again with `startFromChar:
nextStartChar` and pass `alreadyCollected` to continue a long page.

## Example

```json
{
  "tabId": "tab-1",
  "mode": "semantic",
  "query": "latest release title, date, and token-related changes",
  "schema": {
    "type": "object",
    "properties": {
      "title": { "type": "string" },
      "date": { "type": "string" },
      "changes": { "type": "array" }
    }
  },
  "selector": "main",
  "maxChars": 12000,
  "includeLinks": true
}
```

`maxChars` defaults to 12,000 and is capped at 50,000. Sensitive-looking lines
(passwords, tokens, API keys, credentials, cookies, sessions) are redacted before
chunks are returned or handed to a host.
