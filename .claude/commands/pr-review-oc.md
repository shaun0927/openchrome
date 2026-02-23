---
name: pr-review-oc
description: Review PRs in openchrome repo with priority-based issue classification
---

# OpenChrome PR Review

**Target**: $ARGUMENTS

- No argument → review ALL open PRs (`gh pr list --state open`)
- PR number → review that PR
- "latest" → most recent open PR

---

## STEP 1: Gather Context

For EACH PR, run:

```bash
gh pr view <N> --json title,body,additions,deletions,files,commits,headRefName,baseRefName
gh pr diff <N>
```

If multiple open PRs exist, check file overlap:
```bash
gh pr list --state open --json number,headRefName,files
```

Read every changed file in full. Do NOT review from the diff alone.

## STEP 2: Find Issues

Check the diff against these 6 areas. For EACH issue found, classify as P0/P1/P2.

| Area | What to Check |
|------|---------------|
| **Chrome/CDP** | Session lifecycle (attach/detach), concurrent `Target.attachToTarget`, ghost tabs, cookie bridging timing |
| **Cross-Platform** | `path.join()` not concat, `os.homedir()` not `env.HOME`, platform guards (`/dev/tty`, `SIGKILL`, `SingletonLock`) |
| **Security** | No unjustified `shell:true`, no credentials logged, no secrets, safe SQLite copy |
| **Pool/Session** | `minPoolSize` ≤ 5, `suppressReplenishment` toggled, pool cleanup, clear errors |
| **Architecture** | Dead code removed, single concern, typed (no `any`), comments explain "why" |
| **Reliability** | Tests for new paths, error propagation, no swallowed promises, resource cleanup |

## STEP 3: Classify Each Issue

| Priority | Definition | Merge Gate |
|----------|-----------|------------|
| **P0** | **Blocker** — security hole, data loss, Chrome crash, MCP protocol corruption, silent auth bypass | **Must fix before merge** |
| **P1** | **Must fix** — ghost tabs, session corruption, cross-platform breakage, unhandled promise crash, resource leak | **Should fix in this PR** |
| **P2** | **Improve** — code style, docs, minor perf, unlikely edge cases | **Can be follow-up** |

Confidence threshold: only report findings with confidence ≥ 60/100.

## STEP 4: Write Review

Use this exact format:

```
## PR #<N>: <title>

### P0 — Blockers (must fix before merge)
- [ ] **[P0]** Description — `file:line` (Confidence: XX/100)
  - Impact: ...
  - Fix: ...

### P1 — Must Fix (should fix in this PR)
- [ ] **[P1]** Description — `file:line` (Confidence: XX/100)
  - Fix: ...

### P2 — Improve (can be follow-up)
- [ ] **[P2]** Description — `file:line`
  - Suggestion: ...

### Summary
| Priority | Count |
|----------|-------|
| P0 | X |
| P1 | X |
| P2 | X |

### Verdict
- P0 = 0, P1 = 0 → ✅ APPROVE
- P0 = 0, P1 > 0 → ⚠️ REQUEST_CHANGES (fixable)
- P0 > 0 → 🚫 BLOCK

### Merge Notes
- Conflict files with other PRs (if any)
- Recommended merge order (if multiple PRs)
```

## STEP 5: Post to GitHub — MANDATORY

Do NOT skip this step. Post the review on EVERY reviewed PR.

**Language Rule**: ALL review comments MUST be written in English. Do NOT use any other language.

```bash
# P0 > 0:
gh pr review <N> --request-changes --body "<Step 4 output>"

# P0 = 0, P1 > 0:
gh pr review <N> --request-changes --body "<Step 4 output>"

# P0 = 0, P1 = 0:
gh pr review <N> --approve --body "<Step 4 output>"
```

Note: self-PRs cannot be approved via API. Use `--comment` instead of `--approve` for own PRs.

---

## OpenChrome Domain Knowledge

Key files:
- `src/chrome/launcher.ts` — Chrome process, profile detection, cookie copy
- `src/cdp/client.ts` — Puppeteer wrapper, cookie bridging, target index
- `src/cdp/connection-pool.ts` — Page pool, batch acquire, maintenance
- `src/session-manager.ts` — Session/worker ownership, `getPage()`
- `src/orchestration/workflow-engine.ts` — Workflow execution, `acquireBatch`
- `src/dom/dom-serializer.ts` — DOM serialization for page content
- `src/utils/ref-id-manager.ts` — Stable element reference IDs (selector stability)
- `src/tools/read-page.ts` — Read page content tool
- `src/mcp-server.ts` — MCP tool registration and JSON-RPC handling

Common P0/P1 patterns:
1. Ghost `about:blank` tabs from pool replenishment during bulk ops (P1)
2. "Tab not found" from session ownership mismatch (P1)
3. Cookie bridging CDP conflicts during concurrent page creation (P0)
4. Profile lock miss → empty temp profile → no auth (P1)
5. `console.log()` in tool handlers → MCP protocol corruption (P0)
6. `process.env.HOME` → Windows breakage (P1)
