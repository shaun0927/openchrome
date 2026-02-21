---
name: pr-review-ccp
description: Review PRs in claude-chrome-parallel repo with CCP-specific quality gates
---

# CCP PR Review

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

If multiple open PRs exist, also check file overlap:
```bash
gh pr list --state open --json number,headRefName,files
```

Read every changed file in full. Do NOT review from the diff alone.

## STEP 2: Score on 6 Axes

Score each axis 0-10. Compute the weighted average.

| # | Axis | Weight | What to Check |
|---|------|--------|---------------|
| 1 | Chrome/CDP Safety | 2x | Session lifecycle (attach/detach), concurrent `Target.attachToTarget` conflicts, ghost tab prevention, cookie bridging timing |
| 2 | Cross-Platform | 1.5x | `path.join()` not concat, `os.homedir()` not `env.HOME`, platform guards for `/dev/tty`/`SingletonLock`/`SIGKILL`, Windows spawn `shell:true` |
| 3 | Security | 2x | No `shell:true` without justification, no credentials logged, no secrets committed, safe SQLite copy under WAL |
| 4 | Pool/Session Mgmt | 1.5x | `minPoolSize` ≤ 5, `suppressReplenishment` correctly toggled, pool cleanup on shutdown, clear error messages |
| 5 | Architecture | 1x | Dead code removed, focused PR (single concern), TypeScript types (no untyped `any`), comments explain "why" |
| 6 | Test/Verification | 1x | Tests for new paths, edge cases covered, verifiable without all platforms |

**Formula**: `(A1×2 + A2×1.5 + A3×2 + A4×1.5 + A5×1 + A6×1) / 9`

- Score ≥ 7.0 → eligible for APPROVE
- Score < 7.0 → REQUEST_CHANGES

## STEP 3: List Issues

For EACH issue found, write one row:

| Severity | Issue | File:Line | Confidence | Fix |
|----------|-------|-----------|------------|-----|
| CRITICAL/HIGH/MEDIUM/LOW | One-line description | `path:line` | XX/100 | Suggested fix |

Only report findings with confidence ≥ 60/100.

Severity definitions:
- **CRITICAL**: Data loss, security hole, Chrome crash, cookie leak
- **HIGH**: Silent failure, ghost tabs, session corruption, auth bypass
- **MEDIUM**: Performance, unclear errors, cross-platform gap
- **LOW**: Style, docs, minor improvement

## STEP 4: Write Verdict

Use this exact format:

```
## PR #<N>: <title>

### Scores
| Axis | Score | Notes |
|------|-------|-------|
| Chrome/CDP Safety | X/10 | ... |
| Cross-Platform | X/10 | ... |
| Security | X/10 | ... |
| Pool/Session Mgmt | X/10 | ... |
| Architecture | X/10 | ... |
| Test/Verification | X/10 | ... |
| **Weighted Avg** | **X.X/10** | |

### Issues
| Severity | Issue | File:Line | Confidence | Fix |
|----------|-------|-----------|------------|-----|
| ... | ... | ... | ... | ... |

### Verdict: APPROVE / REQUEST_CHANGES

### Merge Notes
- Conflict files with other PRs (if any)
- Recommended merge order (if multiple PRs)
```

## STEP 5: Post to GitHub — MANDATORY

Do NOT skip this step. Post the review on EVERY reviewed PR.

```bash
# If ANY CRITICAL or HIGH issue exists:
gh pr review <N> --request-changes --body "<Step 4 output>"

# If only MEDIUM/LOW or no issues:
gh pr review <N> --approve --body "<Step 4 output>"
```

---

## CCP Domain Knowledge

Key files:
- `src/chrome/launcher.ts` — Chrome process, profile detection, cookie copy
- `src/cdp/client.ts` — Puppeteer wrapper, cookie bridging, target index
- `src/cdp/connection-pool.ts` — Page pool, batch acquire, maintenance
- `src/session-manager.ts` — Session/worker ownership, `getPage()`
- `src/orchestration/workflow-engine.ts` — Workflow execution, `acquireBatch`

Common bugs:
1. Ghost `about:blank` tabs from pool replenishment during bulk ops
2. "Tab not found" from session ownership mismatch
3. Cookie bridging CDP conflicts during concurrent page creation
4. Profile lock miss → empty temp profile → no authentication
