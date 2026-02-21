---
name: code-review-ccp
description: Deep code review for CCP using 3 parallel specialist agents with confidence scoring
---

# CCP Deep Code Review

**Target**: $ARGUMENTS

- No argument → review staged + unstaged changes (`git diff HEAD`)
- File path → review that file
- Directory → review all `.ts` files in it
- "all" → review entire `src/` directory

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
- `subagent_type`: `"ccp-code-reviewer"`
- `model`: `"sonnet"`
- Prompt: List every file path. Tell it to read each file, apply 6 CCP review axes, and return findings sorted by severity. Minimum confidence: 60/100.

**Agent 2 — Silent Failure Hunter**:
- `subagent_type`: `"ccp-silent-failure-hunter"`
- `model`: `"sonnet"`
- Prompt: List every file path. Tell it to hunt empty catches, swallowed CDP errors, unhandled promises, missing error propagation, state corruption, and resource leaks. Minimum confidence: 60/100.

**Agent 3 — Platform Reviewer**:
- `subagent_type`: `"ccp-platform-reviewer"`
- `model`: `"sonnet"`
- Prompt: List every file path. Tell it to check for `process.env.HOME`, `/dev/tty`, hardcoded paths, `SIGKILL`/`SIGTERM` without platform guards, and `spawn` shell issues. Minimum confidence: 60/100.

**IMPORTANT**: Pass the full absolute file paths in the prompt. Do NOT use placeholders like `{file_list}`.

## STEP 3: Wait for All 3 Agents

Do NOT proceed until all 3 agents return results.

## STEP 4: Deduplicate and Merge

1. Collect all findings from the 3 agents
2. If two agents found the same issue (same file + same line + same problem), keep only the higher-confidence one
3. Sort all findings: CRITICAL → HIGH → MEDIUM → LOW

## STEP 5: Output Report

Use this exact format:

```
# CCP Code Review Report

**Scope**: [list of files]
**Agents**: Code Reviewer, Silent Failure Hunter, Platform Reviewer
**Findings**: X total (Y critical, Z high, W medium, V low)

---

## CRITICAL

### [CRITICAL] Title (Confidence: XX/100, Agent: Name)
**File**: `path:line`
**Impact**: What breaks
**Fix**: How to fix

## HIGH
(same format)

## MEDIUM
(same format)

## LOW
(same format)

---

## Agent Summary

| Agent | Total | Critical | High | Medium | Low |
|-------|-------|----------|------|--------|-----|
| Code Reviewer | X | ... | ... | ... | ... |
| Silent Failure Hunter | X | ... | ... | ... | ... |
| Platform Reviewer | X | ... | ... | ... | ... |
| **Deduplicated Total** | **X** | ... | ... | ... | ... |

## Verdict: PASS / NEEDS_FIXES / CRITICAL_ISSUES

Action Items:
- [ ] ...
```

## Verdict Rules

| Condition | Verdict |
|-----------|---------|
| ANY critical finding | **CRITICAL_ISSUES** |
| 3+ high findings | **NEEDS_FIXES** |
| Otherwise | **PASS** |
