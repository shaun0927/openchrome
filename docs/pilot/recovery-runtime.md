# Pilot recovery runtime

`oc_pilot_run_with_recovery` is a pilot-only wrapper for one host-selected tool
call plus bounded deterministic recovery recipes. It is unavailable unless the
pilot gate and contract runtime family are enabled:

```bash
OPENCHROME_PILOT=1 OPENCHROME_CONTRACT_RUNTIME=1 node dist/index.js serve
```

## Bounds

- `maxRecoveryAttempts` defaults to 1 and must be `<= 3`.
- Unsafe tools (`cookies`, `storage`, `http_auth`, `file_upload`, `tabs_close`,
  `oc_stop`) are rejected.
- No server-side LLM calls are made.
- Recovery recipes are declared and deterministic.

## Implemented recipes

| Recipe | Behavior |
| --- | --- |
| `refresh_dom_state` | Calls `read_page` with bounded DOM output. |
| `wait_for_page_ready` | Calls `wait_for` with a bounded timeout. |
| `restore_checkpoint` | Emits metadata-only restore action evidence. |

`reacquire_ref` and `switch_to_programmatic_click` are reserved names and return
validation errors until a follow-up implements them.

## Dry run

`dryRun: true` proposes bounded recipes without executing the original action.
Use it to inspect what the runtime would attempt before allowing side effects.

## Output

The tool returns JSON with `status`, `original`, `postcondition`, `recovery`, an
optional redacted `checkpointId`, and `durationMs`. Every recovery attempt lists
its recipe, reason, deterministic actions, and postcondition evaluation state.
