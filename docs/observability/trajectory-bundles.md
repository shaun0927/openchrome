# Trajectory bundles

Trajectory bundles are default-off, file-based observability artifacts for long-running OpenChrome episodes. They unify recording actions, contract results, and checkpoint snapshots without changing browser/tool behavior.

Enable them when starting a recording:

```json
{ "label": "debug run", "trajectoryBundle": true }
```

A bundle is written under `~/.openchrome/trajectories/<trajectory_id>/`:

```text
meta.json
events.jsonl
screenshots/
checkpoints/
contracts/
report.json
```

`events.jsonl` is append-only and uses strictly increasing `seq` values. Event summaries are bounded to 4 KiB and redact password/token/secret/credential/api-key style fields. Sensitive tools such as cookies and HTTP auth are summarized as redacted.

The writer is best-effort: bundle failures are logged and disabled, but the original MCP tool call continues. OpenChrome does not make LLM decisions, retry actions, recover checkpoints, or stop episodes based on the bundle.

## Merge validation

1. Run `oc_recording_start` with `{ "trajectoryBundle": true }`.
2. Navigate to `https://example.com`, run `read_page`, run one passing and one failing `oc_assert`, then run `oc_checkpoint` with completed and pending steps.
3. Run `oc_recording_stop`.
4. Verify `meta.json`, `events.jsonl`, `contracts/`, `checkpoints/`, and `report.json` exist in the returned bundle directory.
5. Verify sequence order:

```bash
jq -r '.seq' ~/.openchrome/trajectories/<id>/events.jsonl | awk 'NR>1 && $1<=prev { exit 1 } { prev=$1 }'
```

6. Type a known fixture password and confirm it is absent:

```bash
! grep -R "super-secret-fixture-password" ~/.openchrome/trajectories/<id>
```

7. Start/stop a normal recording without `trajectoryBundle:true`; no new trajectory directory should be created.
