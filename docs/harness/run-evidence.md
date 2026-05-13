# Run harness auto evidence

The opt-in run harness automatically writes a lightweight evidence bundle when a recorded tool call finishes with `ok:false` or carries progress metadata with `status: "stuck"`/`"stalling"`.

Artifacts are written under `~/.openchrome/run-evidence/<run_id>/<evidence_id>/metadata.json` by default. Set `OPENCHROME_RUN_EVIDENCE_DIR` or construct `RunStore({ evidenceRootDir })` in tests to redirect output.

The metadata includes `run_id`, `session_id`, `tab_id`, trigger, failure category, URL/title when supplied in event metadata, screenshot/network/console omitted reasons, and the last 10 tool-call summaries. Screenshot capture is disabled in this safe-mode writer; use `oc_evidence_bundle` for full live page snapshots. Evidence write failure is best-effort and never changes the original tool event result.
