# Auto-Recall Domain Skills on Navigate

Auto-recall injects stored domain skills into `navigate` and `tabs_create` responses
so the LLM receives relevant procedural memory without an explicit `oc_skill_recall` call.

## Activation

Auto-recall is **opt-in**. It activates when **either** condition is true:

| Condition | How |
|-----------|-----|
| Global flag | Set `OPENCHROME_AUTO_RECALL=1` in the server environment |
| Per-call override | Pass `recall: true` in the tool arguments |

Per-call `recall` takes precedence over the global flag:

| `OPENCHROME_AUTO_RECALL` | `recall` arg | Result |
|--------------------------|--------------|--------|
| unset / `0` | absent | no injection |
| unset / `0` | `true` | injected |
| `1` | absent | injected |
| `1` | `false` | no injection |

With the flag off and no `recall` arg the response shape is byte-identical to the
pre-v1.11 baseline (P2 zero-impact guarantee).

## Payload Shape

When active, the response gains a `domain_skills` field:

```typescript
interface AutoRecallSummary {
  name: string;       // skill name
  domain: string;     // domain the skill was recorded for
  body: string;       // JSON-encoded { name, steps }
  truncated: boolean; // true when the body was clipped to the byte ceiling
}

interface AutoRecallPayload {
  skills: AutoRecallSummary[];
  truncated: boolean;   // true when the list or any body was clipped
  total_bytes: number;  // total byte length of all included bodies
}
```

## Size Ceilings

| Ceiling | Default |
|---------|---------|
| Max skills per response | 3 |
| Max bytes per skill body | 2048 |
| Max total bytes (all bodies) | 8192 |

When a ceiling is hit `truncated: true` is set at the skill and/or payload level.

## Example

```jsonc
// navigate with OPENCHROME_AUTO_RECALL=1 or recall:true
{
  "action": "navigate",
  "url": "https://amazon.com/...",
  "title": "Amazon.com",
  "tabId": "...",
  "domain_skills": {
    "skills": [
      {
        "name": "add-to-cart",
        "domain": "amazon.com",
        "body": "{\"name\":\"add-to-cart\",\"steps\":[{\"kind\":\"click\",\"selector\":\"#buy-now\"}]}",
        "truncated": false
      }
    ],
    "truncated": false,
    "total_bytes": 72
  }
}
```

## Portability-Harness Alignment

- **P1**: pure request/response — no side effects.
- **P2**: flag-off path is byte-identical to current behavior.
- **P3**: local-only reads from `~/.openchrome/skill-memory/`; no network or LLM calls.
- **P5**: reuses the existing JSON skill store; no new files or formats.

## Related Tools

- `oc_skill_record` — write a skill to the store.
- `oc_skill_recall` — explicit domain skill lookup with optional `contract_id` filter.
