# Recording replay reports

OpenChrome recording reports are self-contained HTML files generated from the
local recording store. Issue #852 enriches each action card with optional
evidence panels while keeping legacy reports unchanged when the new evidence
fields are absent.

## Generate a report

From the MCP tool surface:

```json
{
  "action": "export",
  "recordingId": "<recording-id>",
  "format": "html"
}
```

From the CLI:

```bash
oc replay list
oc replay report <recording-id> --out /tmp/report.html
oc replay terminal <recording-id>
```

`oc replay report` exits `0` on success, `2` for an unknown recording or usage
error, and `3` for filesystem I/O failures.

## Evidence panels

The HTML renderer conditionally shows four collapsed `<details>` panels on each
action card. If an action has no data for a panel, that panel is omitted.

| Panel | Recording field | Contents |
| --- | --- | --- |
| Outcome Contracts | `contractResults` | Assertion JSON, verdict badges (`pass`, `fail`, `inconclusive`), and details. |
| Verify | `verify` | Verbatim verify payload emitted by action tools. Intended for AX/pHash deltas once richer verify producers are wired. |
| Network | `network` | Method, URL, status, and duration for requests correlated with the action. |
| Console | `console` | Console level, text, and timestamp entries emitted during the action. |

When any action has contract results, the report summary includes a contracts
row such as:

```text
Contracts: 1 pass / 0 fail / 0 inconclusive
```

## `oc_assert` wiring

When a recording is active, `oc_assert` appends its Outcome Contract verdict to
the most recent recorded action:

- No active recorder: no-op; `oc_assert` returns normally.
- Active recorder with at least one action: append to that latest action's
  `contractResults`.
- Active recorder with zero prior actions: no-op; the assertion verdict still
  appears in the `oc_assert` tool response but no synthetic recording action is
  created.

This makes assertions evidence about the preceding action instead of standalone
report steps.

## Bounds and truncation

The recorder enforces hard per-action ceilings before writing evidence:

| Field | Ceiling | Truncation behavior |
| --- | --- | --- |
| `contractResults` | 4 KiB total JSON | Replaced with a truncation placeholder containing `originalBytes`. |
| `network` | 20 entries | First 20 entries kept, then a truncation marker. |
| `console` | 20 entries | First 20 entries kept, then a truncation marker. |
| Screenshots | Existing 20 MiB embed ceiling | Existing replay-viewer behavior is unchanged. |

These caps keep reports reviewable and avoid unbounded evidence payloads.

## Deterministic rendering for snapshots

Set `OPENCHROME_REPLAY_DETERMINISTIC=1` when rendering a report for snapshot or
SHA comparison. The renderer keeps the recording data unchanged on disk but
normalizes wall-clock display strings in the HTML output:

```bash
OPENCHROME_REPLAY_DETERMINISTIC=1 oc replay report <recording-id> --out /tmp/report.det.html
```

Use this only for verification; normal human-facing reports preserve real
timestamps.

## Verification anchors

- Contract panel: `tests/recording/html-template.contract.test.ts`
- Verify panel: `tests/recording/html-template.verify.test.ts`
- Network/console panel and truncation: `tests/recording/html-template.network.test.ts`
- Recorder bounds: `tests/recording/action-recorder.bounds.test.ts`
- `oc_assert` recorder wiring: `tests/tools/oc-assert.recorder-wiring.test.ts`
- CLI replay commands: `tests/cli/replay.test.ts`
