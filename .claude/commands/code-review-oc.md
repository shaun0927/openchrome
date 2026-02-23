---
name: code-review-oc
description: Deep code review for OpenChrome using 3 parallel specialist agents with P0/P1/P2 classification
---

# OpenChrome Deep Code Review

**Target**: $ARGUMENTS

- No argument → review staged + unstaged changes (`git diff HEAD`)
- File path → review that file
- Directory → review all `.ts` files in it
- "all" → review entire `src/` directory

---

## Priority Definitions

Tell ALL agents to use this classification:

| Priority | Definition | Examples |
|----------|-----------|---------|
| **P0** | **Blocker** — must fix before merge | Security hole, Chrome crash, MCP stdout corruption, silent auth bypass, data loss |
| **P1** | **Must fix** — should fix in this PR | Ghost tabs, session corruption, cross-platform breakage, unhandled promise crash, resource leak |
| **P2** | **Improve** — can be follow-up | Code style, docs, minor perf, unlikely edge cases |

---

## STEP 1: Collect File List

```bash
# No argument:
git diff --name-only HEAD
git diff --name-only --cached

# Or use the specified path/directory
```

Store the file list. You will pass it to all 3 agents.

## STEP 2: Launch 3 Agents in Parallel

Launch ALL THREE at once using the Task tool. Each receives the SAME file list.

**Agent 1 — Code Reviewer**:
- `subagent_type`: `"oc-code-reviewer"`
- `model`: `"sonnet"`
- Prompt: List every absolute file path. Tell it to:
  1. Read each file in full
  2. Check against 6 OpenChrome areas (Chrome/CDP, Cross-Platform, Security, Pool/Session, Architecture, Reliability)
  3. Classify each finding as P0, P1, or P2
  4. Only report findings with confidence ≥ 60/100

**Agent 2 — Silent Failure Hunter**:
- `subagent_type`: `"oc-silent-failure-hunter"`
- `model`: `"sonnet"`
- Prompt: List every absolute file path. Tell it to:
  1. Hunt empty catches, swallowed CDP errors, unhandled promises, missing error propagation, state corruption, resource leaks
  2. Classify each finding as P0, P1, or P2
  3. Only report findings with confidence ≥ 60/100

**Agent 3 — Platform Reviewer**:
- `subagent_type`: `"oc-platform-reviewer"`
- `model`: `"sonnet"`
- Prompt: List every absolute file path. Tell it to:
  1. Check for `process.env.HOME`, `/dev/tty`, hardcoded paths, `SIGKILL`/`SIGTERM` without platform guards, `spawn` shell issues
  2. Classify each finding as P0, P1, or P2
  3. Only report findings with confidence ≥ 60/100

**IMPORTANT**: Pass full absolute file paths. Do NOT use placeholders.

## STEP 3: Wait for All 3 Agents

Do NOT proceed until all 3 agents return results.

## STEP 4: Deduplicate and Merge

1. Collect all findings from 3 agents
2. If two agents found the same issue (same file + line + problem), keep the higher-confidence one
3. Group by priority: P0 → P1 → P2

## STEP 5: Output Report

Use this exact format:

```
# OpenChrome Code Review Report

**Scope**: [list of files]
**Agents**: Code Reviewer, Silent Failure Hunter, Platform Reviewer

---

## P0 — Blockers (must fix)

### [P0] Title (Confidence: XX/100, Agent: Name)
**File**: `path:line`
**Impact**: What breaks
**Fix**: How to fix

## P1 — Must Fix

### [P1] Title (Confidence: XX/100, Agent: Name)
**File**: `path:line`
**Fix**: How to fix

## P2 — Improve

### [P2] Title (Agent: Name)
**File**: `path:line`
**Suggestion**: ...

---

## Summary

| Agent | P0 | P1 | P2 | Total |
|-------|----|----|----|-------|
| Code Reviewer | X | X | X | X |
| Silent Failure Hunter | X | X | X | X |
| Platform Reviewer | X | X | X | X |
| **Deduplicated** | **X** | **X** | **X** | **X** |

## Verdict

| Condition | Result |
|-----------|--------|
| P0 > 0 | 🚫 **BLOCK** — fix all P0s before merge |
| P0 = 0, P1 > 0 | ⚠️ **FIX** — address P1s in this PR |
| P0 = 0, P1 = 0 | ✅ **PASS** |
```
