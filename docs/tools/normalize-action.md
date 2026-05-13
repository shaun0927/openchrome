# `oc_normalize_action`

`oc_normalize_action` validates and normalizes a near-valid browser/computer action payload without executing it. It is intended for host agents that produced aliases such as `left_click`, `hotkey`, `coordinate`, or a click missing its default button.

The tool is side-effect-free: it does not touch Chrome, CDP, tabs, DOM, cookies, storage, or files. Existing action tools do not auto-normalize; callers must explicitly invoke this tool and then decide whether to call a real action tool with the returned `normalized` payload.

## Input

```json
{
  "action": { "type": "left_click", "coordinate": [100, 200] },
  "strict": true,
  "redactNormalized": false
}
```

- `action` — required candidate action object.
- `targetTool` — optional context (`computer`, `interact`, `act`, `javascript_tool`); currently advisory only.
- `strict` — default `true`; invalid or incomplete actions return `ok:false`.
- `redactNormalized` — default `false`; when true, caller-provided string payload values in `normalized` are replaced with `[REDACTED]`.

## Normalization rules

| Input shape | Normalized shape |
| --- | --- |
| `{type:"left_click", x, y}` | `{type:"click", button:"left", x, y}` |
| `{type:"right_click", x, y}` | `{type:"click", button:"right", x, y}` |
| `{type:"hotkey", keys:"Ctrl-L"}` | `{type:"keypress", keys:["Ctrl","L"]}` |
| `{type:"press", key:"Enter"}` | `{type:"keypress", keys:["Enter"]}` |
| `{type:"click", coordinate:[10,20]}` | `{type:"click", x:10, y:20, button:"left"}` |
| `{button:"left", x, y}` | `{type:"click", button:"left", x, y}` |
| `{text:"abc"}` | `{type:"type", text:"abc"}` |

Unknown fields are dropped from `normalized` with a warning. They are not removed from the caller's original input.

## Safety flag

`requiresUserConfirmation` is set when action text/labels contain any of these case-insensitive keywords:

`submit`, `purchase`, `buy`, `checkout`, `pay`, `delete`, `remove`, `upload`, `login`, `sign in`, `authenticate`, `transfer`, `send`.

This is a conservative deterministic guard, not a complete security classifier. The tool still does not execute the action.

## Non-goals

- No automatic clicking, typing, retrying, or recovery.
- No LLM-based intent classification.
- No full irreversible-action safety review.
- No changes to `act`, `interact`, or `computer` runtime behavior.
