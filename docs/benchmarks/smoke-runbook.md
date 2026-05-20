# Competitor smoke matrix — 6-way live runbook

Operator-facing runbook for executing the `#1255` competitor smoke matrix
(`tests/benchmark/run-competitor-smoke.ts`) against all six libraries in **live
mode**.

The smoke proves a *harness precondition*, not a performance comparison:
every library (OpenChrome, Playwright, Puppeteer, Crawlee, playwright-mcp,
browser-use) executes the same `tabs_create → read_page → tabs_close`
contract against the same local fixture page, and each row records a pinned
version + the same task-contract label. Once 6/6 rows are `passed`, the
foundation row (#1255) of the benchmark readiness audit can promote, and
the comparison axes (#A–#F) are entitled to claim "all six libraries were
measured under identical conditions."

The CI-default (`npm run bench:competitor-smoke`) only exercises the
no-Chrome rows (OpenChrome stub + Crawlee Cheerio). The live 6-way run is a
deliberate, operator-supervised execution because it requires external
runtimes that cannot be carried by the repo.

---

## 1. One-time environment

```bash
# 1a. Build OpenChrome so OpenChromeRealAdapter can spawn dist/index.js
npm install
npm run build

# 1b. Start the operator-owned Chrome on a known CDP port + isolated profile
# (use a profile dir that is NOT your normal user profile — the smoke
# will create/close tabs and you do not want production browser state
# affected).
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/oc-bench-profile \
  --no-first-run \
  --no-default-browser-check &

# Confirm CDP is reachable
curl -fsS http://127.0.0.1:9222/json/version | jq .

# 1c. Install the browser-use Python package at the exact pinned version
#   (use a dedicated venv so the system Python is not polluted)
python3 -m venv ~/.venvs/oc-bench
source ~/.venvs/oc-bench/bin/activate
pip install --upgrade pip
pip install browser-use==0.12.6
python3 -c "import importlib.metadata; print(importlib.metadata.version('browser-use'))"
# expected output: 0.12.6
```

The pinned versions for every library come from `benchmark/COMPETITORS.md`.
If `pip install` resolves a different `browser-use` version, **stop** —
either pin the registry or pin the install; do not run a smoke that records
a version the rest of the suite does not expect.

## 2. Per-adapter environment variables

`run-competitor-smoke.ts` reads the operator's runtime exclusively through
environment variables — the smoke never launches its own Chrome, never
ships a Python bridge, never guesses a CDP port. Export all four before
running the matrix:

```bash
# Shared operator Chrome — every CDP-attaching adapter co-locates here,
# so Playwright, Puppeteer, OpenChrome live, and playwright-mcp all
# observe the same page on the same browser.
export OPENCHROME_BENCH_CDP_ENDPOINT=http://127.0.0.1:9222

# playwright-mcp — server entrypoint of the @playwright/mcp package
export PLAYWRIGHT_MCP_SERVER_PATH="$(node -p "require.resolve('@playwright/mcp/cli.js')")"
# If the resolve fails (older versions used a different bin name), inspect
# node_modules/@playwright/mcp/package.json — the "bin" field names the
# correct file.

# browser-use — Python interpreter + bridge script
export BROWSER_USE_PYTHON="$HOME/.venvs/oc-bench/bin/python3"
export BROWSER_USE_BRIDGE_SCRIPT="$(pwd)/tests/benchmark/bridges/browser_use_bridge.py"
```

Adapters that do not require an env var (Crawlee — Cheerio-only;
OpenChrome stub — used only in CI mode) are silent here.

## 3. Run the 6-way smoke

```bash
npm run bench:competitor-smoke -- \
  --include-live \
  --library all \
  --timeout-ms 60000
```

Flags:

- `--include-live` — flips the four CDP-required adapters from
  `skipped/not_requested` to actual execution. Without this flag the
  matrix runs in CI-safe mode (only OpenChrome stub + Crawlee execute).
- `--library all` — the default; restrict to a single library for
  debugging (e.g. `--library browser-use`) when an adapter is failing.
- `--timeout-ms 60000` — per-tool-call timeout. The CI default of
  `30000` is tight for cold playwright-mcp/browser-use bridges; raise
  it for first-time live runs.

Output:

- `benchmark/results/competitor-smoke.json` — full envelope (axis,
  environment metadata, competitor pins, per-row results).
- stdout — one human-readable line per library, summarising
  `status / version / skip-category / payloadChars / note`.

## 4. Pass criteria — the six gates

The foundation row of the readiness audit can only promote when every
gate below holds in `benchmark/results/competitor-smoke.json`:

1. **All six libraries `status: "passed"`.**
   - OpenChrome (`dom-live`), Playwright (`raw-html-cdp`), Puppeteer
     (`raw-html-cdp`), Crawlee (`cheerio-text`), playwright-mcp
     (`native-mcp`), browser-use (`python-bridge`).
   - A row with `status: "failed", failure: "empty_payload: ..."` means
     the three calls succeeded but `read_page` returned no text — the
     sanity gate added in the smoke runner — and counts as a fail.

2. **All six rows `payloadChars > 0`.**
   - Confirms each `read_page` actually produced text content the
     downstream axes (#A token efficiency, #B agent success, …) can
     measure against.

3. **All six rows `sameTaskContract: true`** with `taskContract:
   "tabs_create/read_page/tabs_close"`.
   - Encoded in the runner; verifies that no adapter quietly substituted
     its own contract.

4. **All six rows `versionPinned: true`** and the `version` value
   matches the pin in `benchmark/COMPETITORS.md`.
   - Mismatches usually mean a competitor was upgraded locally but the
     registry was not updated — fix the registry first, do not record
     an unpinned run.

5. **Envelope `environment` block populated** — `chromeVersion`,
   `gitSha`, `os`, `cpuModel`, `nodeVersion`, `networkProfile`,
   `capturedAt`. `result.schema.json` validates this for you.

6. **`tokenizer: "cl100k_base"`** appears in the envelope. Tokens
   reported by `#A` downstream must be labelled `cl100k_base tokens`,
   not "Claude tokens" — the smoke envelope's tokenizer field is the
   anchor for that label discipline.

A run that meets gates 1–6 is the artifact PR ④ (results refresh) needs
to attach to develop; PR ⑤ then flips the readiness-audit verdict on
#1255 from `partial` → `ready`.

## 5. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Playwright skipped, dependency_missing` even though `playwright` is installed | `require.resolve` failed because the smoke ran from a worktree without `node_modules` | Run from a worktree that has `npm install` applied, or `ln -s ../openchrome/node_modules ./node_modules` for the smoke run only |
| `playwright-mcp failed: spawn ENOENT` | `PLAYWRIGHT_MCP_SERVER_PATH` resolved to a path that does not exist | `node -p "require.resolve('@playwright/mcp/cli.js')"` may fail on newer versions; inspect `node_modules/@playwright/mcp/package.json` `bin` field for the right entry |
| `browser-use failed: ModuleNotFoundError: browser_use` | `BROWSER_USE_PYTHON` points at a Python without the package | Activate the venv that has `browser-use==0.12.6` installed and re-export `BROWSER_USE_PYTHON` to its `bin/python3` |
| Playwright/Puppeteer `connect ECONNREFUSED 127.0.0.1:9222` | Operator Chrome not running, or running on a different port | Re-run the Chrome launch from §1b; confirm `curl http://127.0.0.1:9222/json/version` returns JSON |
| OpenChrome live `tabs_create returned no text payload` | The CDP port in `OPENCHROME_BENCH_CDP_ENDPOINT` does not match the Chrome you launched | Make sure the port in the URL matches `--remote-debugging-port` |
| All four live rows `passed` but `payloadChars: 0` (now demoted to `failed`) | Adapter built an empty payload — usually a navigation timeout that did not throw | Raise `--timeout-ms`, or restart Chrome and retry; check whether the local fixture server is reachable |
| `versionPinned: false` for a library that was pinned yesterday | A `pip install` / `npm install` upgraded the package past the registry pin | Re-pin in `benchmark/COMPETITORS.md` *and* `REGISTRY_PINNED_VERSIONS` in the smoke runner; do not record an unpinned run |

## 6. Related issues

- Epic: [#1254](https://github.com/shaun0927/openchrome/issues/1254) Competitive Benchmark Suite
- This axis: [#1255](https://github.com/shaun0927/openchrome/issues/1255) Benchmark #0 Harness Foundation
- Methodology: `benchmark/COMPETITORS.md`, `tests/benchmark/schemas/result.schema.json`
- Audit consumer: `benchmark/results/BENCHMARK-READINESS.md` (regenerated after the smoke result file is updated)
