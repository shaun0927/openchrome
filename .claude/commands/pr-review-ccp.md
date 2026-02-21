---
name: pr-review-ccp
description: Review PRs in claude-chrome-parallel repo with CCP-specific quality gates
---

You are a critical code reviewer for the **claude-chrome-parallel (CCP)** repository — a Puppeteer-based MCP server for browser automation.

## Target

$ARGUMENTS

If no argument is given, review ALL open PRs: `gh pr list --state open`
If a PR number is given, review that specific PR: `gh pr view <number>`
If "latest" is given, review the most recent open PR.

## Review Protocol

### Phase 1: Context Gathering

For each PR, gather:
```bash
gh pr view <N> --json title,body,additions,deletions,files,commits,headRefName,baseRefName,reviews
gh pr diff <N>
```

Also check for merge conflicts between open PRs:
```bash
gh pr list --state open --json number,headRefName,files
```

### Phase 2: Apply CCP-Specific Review Axes

Score each axis 0-10. **Overall must be >= 7 to approve.**

#### Axis 1: Chrome/CDP Safety (weight: 2x)
- Does the change handle CDP session lifecycle correctly? (attach/detach, error cleanup)
- Are there concurrent `Target.attachToTarget` calls that could conflict?
- Does pool page creation skip unnecessary cookie bridging?
- Are `about:blank` ghost tabs prevented? (check replenishment logic)
- Is `browser.newPage()` called with proper context handling?

#### Axis 2: Cross-Platform Correctness (weight: 1.5x)
- Does the change work on macOS, Linux, AND Windows?
- Are file paths constructed with `path.join()` not string concatenation?
- Are platform-specific APIs (`/dev/tty`, `SingletonLock`, Keychain) properly guarded?
- Is `process.env.HOME` replaced with `os.homedir()`?
- Does `spawn()` use `shell: true` only when necessary (and documented why)?

#### Axis 3: Security (weight: 2x)
- No `shell: true` in `spawn` without justification (command injection risk)
- No credential/cookie data logged to stderr
- No secrets in committed files
- Cookie handling follows secure practices (httpOnly, sameSite)
- `fs.copyFileSync` on sensitive files (Cookies DB) — is it safe while Chrome writes?

#### Axis 4: Pool & Session Management (weight: 1.5x)
- Is `minPoolSize` reasonable? (>5 causes ghost tabs)
- Does `acquireBatch` suppress replenishment correctly?
- Are pool pages cleaned up on workflow_cleanup?
- Is `suppressReplenishment` flag properly set/unset?
- Do session ownership checks produce clear error messages (not just "Tab not found")?

#### Axis 5: Architecture & Code Quality (weight: 1x)
- Is dead code removed? (unused imports, unreachable methods)
- Are error handlers specific (not generic catch-all)?
- Do comments explain "why" not "what"?
- Is the PR focused (single concern) or does it bundle unrelated changes?
- Are TypeScript types used (no `any` without justification)?

#### Axis 6: Test Coverage & Verification (weight: 1x)
- Are there tests for new logic paths?
- Is the test plan in the PR description realistic and verifiable?
- Are edge cases addressed? (locked files, network timeouts, permission errors)
- Can the changes be verified without a Windows/Linux machine?

### Phase 3: Conflict Analysis

Check if any open PRs modify the same files:
```bash
# For each pair of open PRs, check file overlap
```

Report:
- Which files conflict
- Recommended merge order
- Whether rebasing is needed

### Phase 4: Generate Review

For each PR, output:

```markdown
## PR #<N>: <title>

### Scores
| Axis | Score | Notes |
|------|-------|-------|
| Chrome/CDP Safety | X/10 | ... |
| Cross-Platform | X/10 | ... |
| Security | X/10 | ... |
| Pool/Session Mgmt | X/10 | ... |
| Architecture | X/10 | ... |
| Test Coverage | X/10 | ... |
| **Weighted Total** | **X/10** | |

### Issues Found
| Severity | Issue | File:Line | Suggested Fix |
|----------|-------|-----------|---------------|
| CRITICAL | ... | ... | ... |
| HIGH | ... | ... | ... |
| MEDIUM | ... | ... | ... |
| LOW | ... | ... | ... |

### Verdict: APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION

### Action Items
- [ ] ...
```

### Phase 5: Post Review Comments (if requested)

```bash
gh pr review <N> --comment --body "<review>"
# or
gh pr review <N> --request-changes --body "<review>"
```

## CCP Domain Knowledge

Key files and their roles:
- `src/chrome/launcher.ts` — Chrome process management, profile detection, cookie copying
- `src/cdp/client.ts` — Puppeteer wrapper, cookie bridging, target indexing
- `src/cdp/connection-pool.ts` — Page pool with pre-warming, batch acquire, maintenance
- `src/session-manager.ts` — Session/worker/target ownership, `getPage()` access control
- `src/tools/orchestration.ts` — workflow_init, worker lifecycle
- `src/orchestration/workflow-engine.ts` — Workflow execution, acquireBatch usage

Common bug patterns in CCP:
1. `about:blank` ghost tabs from pool replenishment during bulk operations
2. "Tab not found" from session ownership mismatch or stale targetIdIndex
3. Cookie bridging CDP session conflicts during concurrent page creation
4. Profile lock detection failing → empty temp profile → no authentication
5. `preWarmForWorkflow` + `acquireBatch` double page creation
