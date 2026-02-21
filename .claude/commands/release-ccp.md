---
name: release-ccp
description: CCP release workflow — triage, review, fix own PRs, merge, and optionally publish
---

# CCP Release Workflow

$ARGUMENTS

---

## STEP 1: Status Check

Run all of these and report results:

```bash
git status
git stash list
git branch -a
gh pr list --state open --json number,title,headRefName,baseRefName,additions,deletions,author,files
npm run build
```

**Gate**: If build fails, fix build errors first. Do NOT proceed with failing build.

## STEP 2: Classify Open PRs

For each open PR, determine ownership:

| Type | How to Identify | Action |
|------|----------------|--------|
| **MY PR** | `author.login` matches repo owner | Review → Fix issues → Merge |
| **OTHER's PR** | Different author | Review → Post comment → Do NOT merge |

List all PRs in a table:

```
| PR # | Title | Author | Type | Files Changed |
|------|-------|--------|------|---------------|
```

## STEP 3: Triage Local Changes

Check for uncommitted local work:

```bash
git status
git stash list
git diff --stat
```

For each local change, classify:

| Change Type | Action |
|-------------|--------|
| Source code (`.ts`) changes | Create PR by category (feat/fix/refactor/chore) |
| `.claude/` agents/commands | Validate YAML frontmatter, bundle into chore PR |
| Temp/experiment files | Delete if not needed |
| Stashed changes | Pop, resolve conflicts, commit or drop |

Create branches and PRs for local changes. Each PR should have a single concern.

**Gate**: All local changes committed or discarded. `git status` shows clean working tree.

## STEP 4: Review Each PR

For EACH open PR (both mine and others'), in order:

### 4a. Run `/pr-review-ccp <N>`

This produces a weighted score and issue list.

### 4b. Check for file conflicts with other PRs

```bash
# Compare changed files across open PRs
gh pr view <N> --json files
```

### 4c. Take action based on ownership + review result

**MY PR with issues (CRITICAL or HIGH)**:
1. `git checkout <branch>`
2. Fix all CRITICAL and HIGH issues
3. `npm run build` — must pass
4. Commit and push fixes
5. Re-run `/pr-review-ccp <N>` — must score ≥ 7.0/10
6. Post final review to GitHub: `gh pr review <N> --approve --body "<review>"`

**MY PR, clean (no CRITICAL/HIGH)**:
1. Post review to GitHub: `gh pr review <N> --approve --body "<review>"`

**OTHER's PR with CRITICAL/HIGH issues**:
1. Post review to GitHub: `gh pr review <N> --request-changes --body "<review>"`
2. Do NOT fix their code. Do NOT merge. Leave for the author.

**OTHER's PR, clean**:
1. Post review to GitHub: `gh pr review <N> --approve --body "<review>"`
2. Still do NOT merge — leave for the author or ask user.

**Gate**: Every PR has a posted GitHub review comment before proceeding.

## STEP 5: Pre-merge Checks

Before merging ANY PR, verify ALL of these:

```bash
npm run build                                         # must pass
git diff --name-only HEAD | wc -l                     # must be 0 (clean tree)
```

Also grep for known anti-patterns:

```bash
grep -r "process\.env\.HOME" src/ --include="*.ts"    # must be 0 results
grep -r "console\.log(" src/ --include="*.ts"          # must be 0 (stdout = MCP)
```

**Gate**: All checks pass. If any fail, fix before merging.

## STEP 6: Merge (MY PRs only)

Determine merge order:
- If PRs modify the same files → merge the base one first, rebase dependent PRs
- If no conflicts → merge in PR number order

For each MY PR:

```bash
gh pr merge <N> --merge --delete-branch
git checkout main && git pull origin main
npm run build                                          # verify after each merge
```

Do NOT merge OTHER's PRs unless the user explicitly says to.

## STEP 7: Cleanup

```bash
# Delete merged local branches
git branch --merged main | grep -v 'main' | xargs git branch -d

# Verify final state
git branch -a
gh pr list --state open
npm run build
git log --oneline -10
```

## STEP 8: Publish (only if user requests)

```bash
npm version patch   # or minor/major per user request
git push origin main --tags
gh release create v$(node -p "require('./package.json').version") --generate-notes
npm publish
```

Skip this step entirely unless the user explicitly asks for a version bump or publish.

---

## Completion Checklist

ALL of these must be true:

- [ ] Every open PR has a GitHub review comment posted
- [ ] All MY PRs: merged or intentionally deferred
- [ ] All OTHER's PRs: reviewed and commented (NOT merged)
- [ ] All CRITICAL/HIGH issues in MY PRs: resolved
- [ ] `npm run build` passes on main
- [ ] No unnecessary branches remain
- [ ] Working tree is clean
