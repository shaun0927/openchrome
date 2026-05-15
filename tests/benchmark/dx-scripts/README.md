# Developer Experience scripts (#1261)

Per-library minimal idiomatic scripts measured for axis #1261:

| Library | Path | Tasks today |
|---|---|---|
| OpenChrome MCP | `openchrome/` | navigate-and-read, form-fill |
| Playwright (raw) | `playwright/` | navigate-and-read, form-fill |
| Puppeteer (raw) | `puppeteer/` | navigate-and-read, form-fill |

Each task implements the same observable behavior across libraries. The LOC of each script is measured by `dx-rubrics.countLoc` and reported in the #F section of the benchmark report.

## Rules — committed up front

1. **Idiomatic best practice** — each script uses the library's documented preferred API. No hand-padding, no hand-optimizing for OpenChrome.
2. **LOC counting** — imports counted; blank lines + `//` + `/* */` comments excluded.
3. **No composite radar** — the report splits into "MCP DX" (libraries that ship an MCP server, scored across all 4 rubrics) vs "Framework DX" (LOC only). Composites are computed only over axes where every compared library participates.

## Expansion

The 2-tasks-per-library set committed today is the floor. Adding a task means:

1. Implementing the same observable behavior in each library's directory
2. Re-running `npm run bench:dx`
3. The runner picks up new tasks automatically (filesystem scan)

The eventual 10-task × 6-library = 60-script matrix is the issue's headline number; this PR ships the harness + 2 tasks × 3 libraries to prove the shape.
