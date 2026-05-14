# Scoped structured extraction

Use `extract_data` with a scope when a page has repeated cards, unrelated JSON-LD,
or global OpenGraph data that can pollute the requested schema.

## Scope options

Exactly one scope may be provided:

- `selector`: CSS selector for a stable page region.
- `ref_id`: element reference from `read_page` or `oc_observe`.
- `backendNodeId`: Chrome backend DOM node id for advanced callers.
- Omit all three for document-level extraction.

For element scopes (`selector`, `ref_id`, or `backendNodeId`), extraction applies the
scope before heuristic strategies run. Document-level JSON-LD, Microdata, and
OpenGraph passes are skipped for element scopes so global page metadata does not
leak into scoped results.

## Example

```json
{
  "tabId": "tab-1",
  "ref_id": "ref_12",
  "schema": {
    "type": "object",
    "properties": {
      "title": { "type": "string" },
      "price": { "type": "string" }
    }
  }
}
```

The response includes scope metadata:

```json
{
  "action": "extract_data",
  "scope": {
    "type": "ref_id",
    "resolved": true,
    "ref_id": "ref_12",
    "backendNodeId": 12345
  }
}
```

If a `ref_id` is stale or missing, call `read_page` or `oc_observe` again and
retry with a fresh ref.
