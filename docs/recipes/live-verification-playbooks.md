# Live verification playbooks (#1044)

These fixtures harden `oc playbook run` with local-only, reviewable scenarios. They are intentionally small and disposable so PR reviewers can run them without accounts, secrets, or external websites.

## Fixture site

Serve the fixture directory from the repository root:

```bash
python3 -m http.server 8765 --directory tests/fixtures/playbook/site
```

## Playbooks

```bash
# Expected: pass
node dist/cli/index.js playbook run tests/fixtures/playbook/recipes/basic-navigation.yaml --json

# Expected: pass; local-only submit path, no external side effects
node dist/cli/index.js playbook run tests/fixtures/playbook/recipes/safe-form.yaml --json

# Expected: fail at step 1 and skip step 2 with structured failure evidence
node dist/cli/index.js playbook run tests/fixtures/playbook/recipes/failure-recovery.yaml --json
```

## Merge evidence required

A PR that modifies the playbook runner should attach the JSON output for all three commands. The failure fixture must show:

- failed step index
- `tool: oc_assert`
- assertion verdict/failure detail
- skipped downstream step

These playbooks use inline `oc_assert` contracts with explicit `evidence.snapshot` so the assertions remain deterministic and do not require an LLM judgement.
