<p align="center">
  <img src="assets/mascot.png?v=4" alt="OpenChrome Raptor" width="180">
</p>

<h1 align="center">OpenChrome</h1>

<p align="center">
  <b>Harness-Engineered Browser Automation</b><br>
  The MCP server that drives and guides AI agents through a real Chrome.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openchrome-mcp"><img src="https://img.shields.io/npm/v/openchrome-mcp" alt="npm"></a>
  <a href="https://github.com/shaun0927/openchrome/releases/latest"><img src="https://img.shields.io/github/v/release/shaun0927/openchrome" alt="Latest Release"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT"></a>
</p>

<p align="center">
  <b>English</b> · <a href="README.ko.md">한국어</a>
</p>

---

## What it is

OpenChrome is an **MCP server** that controls your real, already-logged-in Chrome
through the Chrome DevTools Protocol — no middleware, no separate browser, no
re-authentication. One Chrome process, many isolated tabs, ~300 MB for 20 parallel
lanes.

It is **harness-engineered**: the server doesn't just expose browser APIs, it wraps
them with a hint engine, a circuit breaker, an automatic-recovery runtime, and
token-efficient page serialization — so the agent makes fewer mistakes, recovers
without "thinking", and burns far fewer tokens.

```
You: compare "AirPods Pro" prices across Amazon, eBay, Walmart, Best Buy

AI:  [4 parallel lanes, already authenticated everywhere]
     Best Buy $179 · Amazon $189 · Walmart $185 · eBay $172
     2.4s — live pages, past bot detection
```

| | Traditional (Playwright et al.) | OpenChrome |
|---|:---:|:---:|
| 5-site task | ~250s (login each) | **~3s** (parallel) |
| Memory | ~2.5 GB (5 browsers) | **~300 MB** (1 Chrome) |
| Re-auth | every run | **never** |
| Bot detection | flagged | **invisible** (real Chrome) |

---

## Quick start

Install and point your MCP client at it — one command:

```bash
npm install -g openchrome-mcp

openchrome setup                       # Claude Code
openchrome setup --client codex        # Codex CLI
npx openchrome-mcp setup --client opencode   # OpenCode
```

Restart your MCP client. That's it — Chrome auto-launches on first tool call.

<details>
<summary>Manual MCP config (Cursor / VS Code / Windsurf / others)</summary>

```json
{
  "mcpServers": {
    "openchrome": {
      "command": "openchrome",
      "args": ["serve", "--auto-launch"]
    }
  }
}
```

Run `openchrome update` later to refresh the CLI and client config.
</details>

**Prefer no terminal?** A one-click [desktop app](https://github.com/shaun0927/openchrome/releases?q=desktop)
(macOS / Windows / Linux, beta) runs the server with no Node.js setup.

---

## What you can do with it

Ask your agent in plain language — these all map to OpenChrome tools:

- **Parallel research** — "screenshot AWS billing, GCP, Stripe, Datadog at once" → 4 lanes, one Chrome, already authenticated.
- **Authenticated scraping** — crawl dashboards and member-only pages using your existing login. No credentials in config.
- **Form & flow automation** — fill, click, navigate multi-step flows; the agent gets corrective hints when a step drifts.
- **Production UI debugging** — `oc_performance_insights` / `oc_vitals` for LCP/CLS, `console_capture`, `oc_devtools_url` to attach live DevTools.
- **Site monitoring & diffing** — `oc_evidence_bundle` snapshots + `oc_diff` for deterministic before/after (DOM, screenshot pHash, network, console).
- **Crawling** — async `crawl_start` / `crawl_status` / `crawl_cancel` jobs with cursor pagination.
- **Verifiable runs** — `oc_assert` checks page state against an Outcome Contract (pass / fail / inconclusive) instead of guessing.

The default surface is ~110 tools across navigation, interaction, reading,
extraction, parallel workflows, contracts, skills, recovery, and diagnostics.
Full catalogue: [`docs/agent/capability-map.md`](docs/agent/capability-map.md).

---

## Using it conveniently

### Drive it from the shell — no MCP host needed

The CLI can call the MCP surface directly. Great for scripts, CI, and debugging:

```bash
oc run navigate --arg url=https://example.com
oc run read_page --arg mode=dom --json
oc navigate https://example.com      # positional sugar for common tools
oc click ref_5
```

### Declarative scenarios with `oc playbook`

Write a YAML scenario where every step is one tool call with an inline
Outcome Contract — deterministic, no LLM judgement:

```bash
oc playbook run scenario.yaml --vars url=https://iana.org --out report.md
```

See [`docs/cli/playbook.md`](docs/cli/playbook.md).

### Keep one browser warm — HTTP daemon mode

Run OpenChrome as a long-lived daemon so multiple clients (Claude Code + CI +
a dashboard) share **one** Chrome process, and the server outlives whatever
launched it (Docker, systemd, CI):

```bash
openchrome serve --http 3100 --auth-token <token> --idle-timeout 30m
curl -s http://127.0.0.1:3100/health
```

One Chrome process, tabs isolated per session. Without `--idle-timeout` it stays
up until stopped; with it, it self-exits after the idle window. Full guide:
[`docs/getting-started/http-daemon.md`](docs/getting-started/http-daemon.md).

### Diagnose your environment

```bash
openchrome doctor      # Node, disk, Chrome binary/port, orphans, perms, locks
openchrome check       # verify CLI + runtime wiring
```

### Token-efficient page reads

`read_page mode="dom"` serializes the page into a compact text form — **~5–15x
fewer tokens** than the raw DOM. Each element carries an affordance marker so the
agent knows the type at a glance:

```
# [142]<input type="search" .../> ★      ← # text input
$ [156]<button type="submit"/>Search ★   ← $ button / control
@ [289]<a href="/home"/>Home ★           ← @ link   (% = visual target)
```

`[backendNodeId]` identifiers are stable for the node's lifetime — pass `142`,
`node_142`, or `ref_N` to any action tool. `oc_observe` goes further: it returns
a ready-to-act numbered list in one call instead of `read_page → query_dom →
inspect → interact`.

---

## Why agents fail less on OpenChrome

The bottleneck in browser automation is the LLM *thinking* between steps — every
wrong guess costs 10–15s of inference. OpenChrome's harness cuts that loop:

| Subsystem | What it does |
|---|---|
| **Hint engine** (30+ rules) | Catches error→recovery patterns and corrects the agent before mistakes cascade. Promotes repeated patterns to permanent rules. |
| **Recovery runtime** | Deterministic, bounded recovery for a tool call — recover in-server, no LLM round-trip (pilot tier). |
| **Ralph engine** | 7-strategy interaction waterfall: AX click → CSS → CDP coords → JS → keyboard → raw mouse → human escalation. |
| **3-level circuit breaker** | Element / page / global — stops the agent burning tokens on permanently broken elements. |
| **Outcome classifier** | Reports what *actually* happened after a click (SUCCESS / SILENT_CLICK / WRONG_ELEMENT). |
| **49 reliability mechanisms** | 8 defense layers from process lifecycle to MCP gateway — no single failure hangs the server. See [`docs/architecture.md`](docs/architecture.md). |

Result on a typical 5-site task: ~80% fewer LLM calls, ~80x faster wall time,
~5x cheaper.

---

## Other capabilities worth knowing

- **Parallel sessions** — 1 Chrome, N tabs/lanes; `workerId` + `profileDirectory` give per-client isolation. Multiple MCP clients can share tabs safely.
- **Anti-bot / Turnstile** — 3-tier auto-fallback (headless → stealth → real headed Chrome) bypasses CDN/WAF blocks. [Turnstile guide](docs/turnstile-guide.md).
- **Interactive login** — headed by default since the launcher runs visible; complete 2FA/CAPTCHA once, reuse the persistent profile after.
- **Session persistence** — `--persist-storage` saves cookies + localStorage atomically for headless reuse.
- **Shadow DOM** — open + closed roots via CDP-pierced reads; `__pierce()` / `__openchrome.querySelectorAllDeep()` helpers in `javascript_tool`.
- **Element intelligence** — find elements by natural language (AX-first, CSS fallback, Korean role keywords built in: `"버튼"` → button).
- **Core / pilot tiers** — core is on by default and preserves the stable surface; `--pilot` opts into contract runtime, handoff persistence, voting, and the skill curator.

---

## Server & headless deployment

```bash
openchrome serve --server-mode     # headless + auto-launch + server defaults
```

Works in CI/CD and containers with no login — navigation, scraping, screenshots,
forms, and parallel workflows all run in clean sessions. A production
`Dockerfile` is included (`docker build -t openchrome . && docker run openchrome`).

Authentication (per-tenant API keys, JWT/OAuth, shared token): [`docs/auth.md`](docs/auth.md).
Transport stability policy: [`docs/transport-lifecycle.md`](docs/transport-lifecycle.md).

---

## Documentation

| Topic | Link |
|---|---|
| Architecture & reliability layers | [`docs/architecture.md`](docs/architecture.md) |
| Getting started walkthrough | [`docs/getting-started.md`](docs/getting-started.md) |
| Full tool catalogue | [`docs/agent/capability-map.md`](docs/agent/capability-map.md) |
| CLI & playbook | [`docs/cli.md`](docs/cli.md) · [`docs/cli/playbook.md`](docs/cli/playbook.md) |
| HTTP daemon mode | [`docs/getting-started/http-daemon.md`](docs/getting-started/http-daemon.md) |
| Research recipes | [`docs/recipes/README.md`](docs/recipes/README.md) |
| Latest release notes | [`docs/releases/v1.12.0.md`](docs/releases/v1.12.0.md) |

---

## Development

```bash
git clone https://github.com/shaun0927/openchrome.git
cd openchrome
npm install && npm run build && npm test
```

Lint before submitting source changes: `npm run lint -- --max-warnings=0`
(or `npm run lint:changed -- --base origin/develop` for changed files only).
PRs target the `develop` branch.

## License

MIT
</content>
