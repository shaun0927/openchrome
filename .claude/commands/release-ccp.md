---
name: release-ccp
description: CCP release workflow — review, fix, merge open PRs then optionally publish
---

# CCP Release Workflow

$ARGUMENTS

## Step 1: Status Check

Run these commands and report the results:

```bash
git status
git stash list
git branch -a
gh pr list --state open --json number,title,headRefName,baseRefName,additions,deletions
```

If working tree is dirty, ask before proceeding.
If no open PRs, skip to Step 5.

## Step 2: Review Each PR

For EACH open PR, do these three things in order:

### 2a. Read the diff
```bash
gh pr diff <N>
```

### 2b. Run the review skill
Use `/pr-review-ccp <N>` to generate a scored review with findings.

### 2c. Post review to GitHub
This is MANDATORY. Do NOT skip this step.

```bash
# If CRITICAL or HIGH issues found:
gh pr review <N> --request-changes --body "<full review markdown>"

# If only MEDIUM/LOW or no issues:
gh pr review <N> --approve --body "<full review markdown>"
```

Repeat 2a-2c for every open PR before moving to Step 3.

## Step 3: Fix Issues

For each PR that got REQUEST_CHANGES:

1. `git checkout <branch>`
2. Fix all CRITICAL and HIGH issues
3. `git commit` the fixes
4. `git push`
5. Re-run `/pr-review-ccp <N>` to verify fixes
6. Post updated review: `gh pr review <N> --approve --body "<updated review>"`

## Step 4: Merge

Check for file conflicts between PRs:
```bash
# For each pair of PRs, compare changed files
gh pr view <N> --json files
```

If conflicts exist, determine merge order (merge the base PR first, rebase dependent PRs).

For each PR in order:
```bash
gh pr merge <N> --merge --delete-branch
```

After all merges:
```bash
git checkout main && git pull origin main
```

## Step 5: Verify

```bash
npm run build
gh pr list --state open
git log --oneline -10
```

Build must pass. Open PRs must be 0.

## Step 6: Publish (optional, only if requested)

```bash
npm version patch  # or minor/major per argument
git push origin main --tags
gh release create v$(node -p "require('./package.json').version") --generate-notes
npm publish
```

Only run Step 6 if the user explicitly requests a version bump or publish.
