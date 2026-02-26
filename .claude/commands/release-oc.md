---
name: release-oc
description: OpenChrome release workflow — triage, review, fix own PRs, merge, and optionally publish
---

# OpenChrome Release Workflow

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
| **MY PR** | `author.login` matches repo owner | Review → Fix P0/P1 → Merge |
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
| Source code (`.ts`) changes | Create PR by category (feat/fix/refactor/chore). **All PR titles, descriptions, and commit messages MUST be in English.** |
| `.claude/` agents/commands | Validate YAML frontmatter, bundle into chore PR |
| Temp/experiment files | Delete if not needed |
| Stashed changes | Pop, resolve conflicts, commit or drop |

**Gate**: All local changes committed or discarded. `git status` shows clean working tree.

## STEP 4: Review Each PR

For EACH open PR (both mine and others'), in order:

### 4a. Run `/pr-review-oc <N>`

This produces a P0/P1/P2 issue list and verdict.

### 4b. Check for file conflicts with other PRs

```bash
gh pr view <N> --json files
```

### 4c. Take action based on ownership + verdict

**MY PR with P0s**:
1. `git checkout <branch>`
2. Fix ALL P0 issues
3. `npm run build` — must pass
4. Commit and push fixes
5. Re-run `/pr-review-oc <N>` — must have P0 = 0
6. If P1s remain, fix those too
7. Repeat until P0 = 0 and P1 = 0

**MY PR, P0 = 0 and P1 = 0**:
1. Post review to GitHub (use `--comment` for self-PRs)

**OTHER's PR with P0 or P1**:
1. Post review to GitHub: `gh pr review <N> --request-changes --body "<review>"`
2. Do NOT fix their code. Do NOT merge. Leave for the author.

**OTHER's PR, clean**:
1. Post review to GitHub: `gh pr review <N> --approve --body "<review>"`
2. Still do NOT merge unless user explicitly says to.

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
grep -r "console\.log(" src/ --include="*.ts"          # must be 0 in tool handlers
```

**Gate**: All checks pass. If any fail, fix before merging.

## STEP 6: Merge (MY PRs only)

Merge order:
- If PRs modify the same files → merge base PR first, rebase dependent PRs
- If no conflicts → merge in PR number order

For each MY PR:

```bash
gh pr merge <N> --merge --delete-branch
git checkout develop && git pull origin develop
npm run build                                          # verify after each merge
```

**Note**: All PRs target the `develop` branch (per CLAUDE.md). To cut a release, merge `develop` into `main` after all PRs are merged and the build is green:

```bash
git checkout main && git pull origin main
git merge develop --no-ff -m "chore: merge develop into main for release"
git push origin main
```

Do NOT merge OTHER's PRs unless the user explicitly says to.

## STEP 7: Cleanup

```bash
git branch --merged develop | grep -v 'develop\|main' | xargs -r git branch -d
git branch -a
gh pr list --state open
npm run build
git log --oneline -10
```

## STEP 8: Publish (only if user requests)

### 8a. Publish to npm

```bash
npm version patch   # or minor/major per user request
git push origin main --tags
gh release create v$(node -p "require('./package.json').version") --generate-notes
npm publish
```

Skip this step entirely unless the user explicitly asks for a version bump or publish.

### 8b. Post-publish: Local Environment Sync

**CRITICAL** — `npm publish` alone does NOT update the local environment.
Skipping this step causes version mismatch where the MCP server runs old code.

```bash
# 1. Update global npm package
npm install -g openchrome-mcp

# 2. Kill all running MCP server processes (they still use the old version)
pkill -f "openchrome.*serve"

# 3. Verify version consistency across all 4 paths
echo "src:    $(node -p \"require('./package.json').version\")" && \
echo "dist:   $(node dist/cli/index.js --version 2>/dev/null)" && \
echo "global: $(npm ls -g openchrome-mcp 2>/dev/null | grep openchrome)" && \
echo "npm:    $(npm view openchrome-mcp version)"
```

**Gate**: All 4 versions must match. If dist is outdated, run `npm run build` first.

After verification, the user must **restart Claude Code** for the new MCP server to take effect.

---

## Completion Checklist

- [ ] Every open PR has a GitHub review comment posted
- [ ] All MY PRs: P0 = 0, P1 = 0, merged
- [ ] All OTHER's PRs: reviewed and commented (NOT merged)
- [ ] `npm run build` passes on develop (and main after release merge)
- [ ] No unnecessary branches remain
- [ ] Working tree is clean
- [ ] (If published) Global npm package matches published version
- [ ] (If published) No zombie MCP server processes running old version
