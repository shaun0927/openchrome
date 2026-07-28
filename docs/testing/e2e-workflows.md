# E2E workflow tiers

OpenChrome's browser E2E coverage is split by purpose and runtime budget.
Every Linux GitHub Actions lane sets `OPENCHROME_E2E_SERVER_ARGS=--server-mode`
so Chrome starts through the supported headless/server path without X11.

| Tier | Trigger | Budget | Coverage |
| --- | --- | --- | --- |
| PR smoke | pull requests | 15 minutes | Core stdio, HTTP, recovery, concurrency, metrics, and tab isolation |
| Nightly functional | schedule or manual dispatch | 45 minutes per parallel lane | Deterministic local stdio and HTTP scenarios, with `TIME_SCALE=0.167` |
| Weekly endurance | schedule or manual dispatch | Independent 60-100 minute jobs | Full-scale marathon, memory stability, and one-hour bounded endurance |
| Weekly external compatibility | weekly, non-gating | 20 minutes | The public SauceDemo checkout scenario |

`tests/e2e/jest.e2e-*.config.js` is the canonical scenario inventory for each
tier. Marathon, memory stability, and endurance are intentionally excluded from
nightly functional coverage; they run at `TIME_SCALE=1` in the weekly workflow.
The external checkout is retained as a separately reported compatibility signal
so public-site availability cannot invalidate the deterministic nightly gate.

Manual workflows accept a full `commit_sha`. The checkout step verifies that
the tested `HEAD` exactly matches that value, allowing repeated validation of
one immutable commit. Every job uploads its log, Jest JSON when applicable,
environment metadata, and any endurance report even when the test command fails.
