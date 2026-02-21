---
name: code-review-ccp
description: Deep code review for CCP using 3 parallel specialist agents with confidence scoring
---

You are orchestrating a **deep code review** of the claude-chrome-parallel (CCP) codebase using 3 specialized agents working in parallel.

## Target

$ARGUMENTS

If no argument is given, review all staged/unstaged changes: `git diff HEAD`
If a file path is given, review that specific file.
If a directory is given, review all `.ts` files in that directory.
If "all" is given, review the entire `src/` directory.

## Phase 1: Determine Scope

```bash
# If no argument, get changed files
git diff --name-only HEAD
git diff --name-only --cached
```

Collect the list of files to review. Read each file to understand context.

## Phase 2: Launch 3 Parallel Specialist Agents

Launch ALL THREE agents simultaneously using the Task tool. Each agent reviews the SAME files but through a different lens.

### Agent 1: CCP Code Reviewer
```
Task(
  subagent_type="ccp-code-reviewer",
  model="sonnet",
  prompt="Review these files for CCP-specific issues across all 6 axes (Chrome/CDP Safety, Cross-Platform, Security, Pool/Session, Architecture, Error Handling). Apply confidence scoring — only report findings >= 60/100.\n\nFiles to review:\n{file_list}\n\nFor each file, read it fully, then apply all 6 review axes. Output findings sorted by severity (CRITICAL > HIGH > MEDIUM > LOW)."
)
```

### Agent 2: Silent Failure Hunter
```
Task(
  subagent_type="ccp-silent-failure-hunter",
  model="sonnet",
  prompt="Hunt for silent failures in these files. Focus on: empty catch blocks, swallowed CDP errors, unhandled promise rejections, missing error propagation, state corruption, and resource leaks.\n\nFiles to review:\n{file_list}\n\nUse ast_grep_search to find structural patterns, then read context around each finding. Only report findings with confidence >= 60/100."
)
```

### Agent 3: Cross-Platform Reviewer
```
Task(
  subagent_type="ccp-platform-reviewer",
  model="sonnet",
  prompt="Check these files for cross-platform compatibility issues. Look for: process.env.HOME, /dev/tty, hardcoded paths, platform-specific APIs without guards, shell commands that differ between OS.\n\nFiles to review:\n{file_list}\n\nFor each finding, specify which platform breaks and suggest the cross-platform alternative. Only report findings with confidence >= 60/100."
)
```

## Phase 3: Aggregate Results

After all 3 agents complete, merge their findings:

1. **Deduplicate**: If multiple agents found the same issue, keep the highest-confidence version
2. **Sort by severity**: CRITICAL → HIGH → MEDIUM → LOW
3. **Count**: Total findings per severity level

## Phase 4: Generate Report

Output the combined review in this format:

```markdown
# CCP Code Review Report

**Scope**: {files reviewed}
**Agents**: 3 parallel specialists (Code Reviewer, Silent Failure Hunter, Platform Reviewer)
**Total Findings**: X (Y critical, Z high, W medium, V low)

---

## CRITICAL Findings

### [CRITICAL] Title (Confidence: XX/100, Agent: {which agent})
**File**: `path:line`
...

## HIGH Findings
...

## MEDIUM Findings
...

## LOW Findings
...

---

## Summary

| Agent | Findings | Critical | High | Medium | Low |
|-------|----------|----------|------|--------|-----|
| Code Reviewer | X | ... | ... | ... | ... |
| Silent Failure Hunter | X | ... | ... | ... | ... |
| Platform Reviewer | X | ... | ... | ... | ... |
| **Total (deduplicated)** | **X** | ... | ... | ... | ... |

## Verdict: PASS / NEEDS_FIXES / CRITICAL_ISSUES

### Action Items
- [ ] ...
```

## Important Notes

- All 3 agents run in PARALLEL for speed
- Each agent has CCP domain knowledge baked in
- Confidence threshold is 60/100 — below that, findings are suppressed
- CRITICAL findings from ANY agent trigger CRITICAL_ISSUES verdict
- 3+ HIGH findings trigger NEEDS_FIXES verdict
- Otherwise PASS
