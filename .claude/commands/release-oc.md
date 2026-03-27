---
name: release-oc
description: OpenChrome release workflow — issue verification, triage, review, fix own PRs, merge, and optionally publish
---

# OpenChrome Release Workflow

$ARGUMENTS

---

## STEP 0: Issue Audit (CRITICAL — do this BEFORE reviewing PRs)

If the release involves specific issues (e.g., `#440`), audit each issue FIRST:

### 0a. Extract Requirements

```bash
gh issue view <N> --json title,body,labels,state
```

For each issue, create a **Requirements Matrix**:

```
| Req ID | Description | Files That Should Change | Verification Method |
|--------|-------------|-------------------------|---------------------|
| P0-1   | normalizeQuery in all tools | fill-form, interact, find, click-element, wait-and-click | grep for normalizeQuery import |
| P0-2   | In-page duplicate comment | element-discovery.ts | Read file, check comment |
| ...    | ... | ... | ... |
```

### 0b. Map PRs to Requirements

```bash
git log --oneline --all --grep="<issue-number>"
gh pr list --search "<issue-number>" --state all --json number,title,state,mergedAt,headRefName
```

Create a **Coverage Matrix**:

```
| Req ID | Covered By | PR Status | Verified in Code |
|--------|-----------|-----------|-----------------|
| P0-1   | PR #442   | merged    | [ ] not yet checked |
| P2-1   | PR #???   | NOT FOUND | [ ] MISSING |
```

**Gate**: If any requirement has NO PR and NO code change, flag it as a **RELEASE BLOCKER**. Do NOT proceed to merge until all requirements are accounted for.

### 0c. Verify Each Requirement in Code

For each requirement, actually check the codebase — not just the PR diff:

```bash
# Example: "normalizeQuery applied in all tools that accept text queries"
grep -r "normalizeQuery" src/tools/ --include="*.ts" -l
# Compare against the list of tools that SHOULD have it
```

Mark each requirement as:
- **PASS** — implemented and verified in current code
- **PARTIAL** — implemented in some but not all required locations
- **MISSING** — not implemented at all
- **UNTESTED** — implemented but no tests exist

**Gate**: Any PARTIAL or MISSING requirement is a **RELEASE BLOCKER**.
UNTESTED requirements should have tests added before release.

---

## STEP 1: Status Check

Run all of these and report results:

```bash
git status
git stash list
git branch -a
gh pr list --state open --json number,title,headRefName,baseRefName,additions,deletions,author,files
npm run build
npm run lint
npm test
```

**Gate**: If build, lint, or tests fail, fix errors first. Do NOT proceed with any failures.

## STEP 2: Classify Open PRs

For each open PR, determine ownership:

| Type | How to Identify | Action |
|------|----------------|--------|
| **MY PR** | `author.login` matches repo owner | Review -> Fix P0/P1 -> Merge |
| **OTHER's PR** | Different author | Review -> Post comment -> Do NOT merge |

List all PRs in a table:

```
| PR # | Title | Author | Type | Linked Issue | Files Changed |
|------|-------|--------|------|-------------|---------------|
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

This produces a P0/P1/P2 issue list and verdict (single-agent inline review).

### 4b. Run `/code-review-oc` on PR changed files (deep specialist review)

Extract the PR's changed files and run a deep code review with 3 parallel specialist agents:

```bash
gh pr diff <N> --name-only
```

Then invoke: `/code-review-oc <space-separated file list>`

This spawns 3 specialist agents in parallel:
- **oc-code-reviewer** — CDP/Puppeteer domain expertise, 6-area review
- **oc-silent-failure-hunter** — empty catches, swallowed errors, resource leaks
- **oc-platform-reviewer** — Windows/Linux/macOS compatibility (paths, signals, process mgmt)

Merge the findings from both 4a and 4b. Use the higher-confidence finding when duplicates exist.

### 4c. Issue-Requirement Verification (NEW — prevents incomplete merges)

For each PR that references an issue:

1. **Scope Check**: Does the PR implement ALL parts of the issue it claims to address, or only a subset?
   - If subset: Is this clearly scoped in the PR title/description? Are there other PRs for remaining parts?
   - If "centralize X across all tools" but only 3 of 7 tools are changed: **P0 BLOCKER**

2. **Test Coverage Check**: Does the PR include tests for new functionality?
   - New function/module with 0 tests: **P1 — must add tests before merge**
   - New behavior branch with 0 coverage: **P1**
   - Refactored code with existing tests still passing: **OK** (no new tests required)

3. **Completeness Grep**: Verify the change was applied everywhere it should be:
   ```bash
   # Example: if PR adds normalizeQuery to tools, verify ALL tools have it
   # List tools that accept text queries:
   grep -rn "query.*as string\|query.*string" src/tools/ --include="*.ts" -l
   # List tools that import normalizeQuery:
   grep -rn "normalizeQuery" src/tools/ --include="*.ts" -l
   # The two lists should match (minus tools that don't need normalization)
   ```

4. **Cross-Reference with STEP 0**: Update the Coverage Matrix. If this PR marks a requirement as PASS, verify it in code.

### 4d. Check Greptile review (if available)

Greptile AI automatically reviews PRs via GitHub App. Fetch its review:

```bash
gh api repos/{owner}/{repo}/pulls/<N>/reviews \
  --jq '[.[] | select(.user.login == "greptile-apps[bot]") | {state: .state, body: .body}]'
```

If Greptile posted a review:
- Cross-reference findings with 4a/4b results
- Add any **NEW** issues Greptile found that our agents missed
- Greptile-only findings default to P2 unless clearly a bug or security issue
- If Greptile requested changes, address them before merging

If no Greptile review yet, proceed — it may arrive later.

### 4e. Check for file conflicts with other PRs

```bash
gh pr view <N> --json files
```

### 4f. Take action based on ownership + verdict

**MY PR with P0s**:
1. `git checkout <branch>`
2. Fix ALL P0 issues (including scope/test gaps from 4c)
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
npm ci                                                 # must pass (lockfile in sync)
npm run build                                          # must pass
npm run lint                                           # must pass (no errors)
npm test                                               # must pass (ALL test suites green)
git diff --name-only HEAD | wc -l                      # must be 0 (clean tree)
```

Also grep for known anti-patterns:

```bash
# Platform safety
grep -r "process\.env\.HOME" src/ --include="*.ts"     # must be 0 — use os.homedir()
grep -rn "'/dev/tty'" src/ --include="*.ts" | grep -v "platform\|win32"  # must be 0 — needs win32 guard
grep -rn "SIGKILL\|SIGTERM" src/ --include="*.ts" | grep -v "platform\|win32"  # must be 0 — needs platform guard
grep -rn "execSync(" src/ --include="*.ts" | grep -v "execFileSync"  # review each — prefer execFileSync

# Code hygiene
grep -r "console\.log(" src/ --include="*.ts"          # must be 0 in tool handlers
```

**If `npm ci` fails**: Run `npm install`, commit `package-lock.json`, then retry.

### Test Coverage Gate (NEW)

For each PR being merged, verify test coverage for new code:

```bash
# Count new/modified source lines vs new test lines
gh pr diff <N> --stat
# If >50 new source lines and 0 new test lines: WARN
# If new exported function/class with 0 test references: BLOCK
```

Specifically check:
- New exported functions: `grep -rn "export function\|export class" <changed-files>`
- Test references: `grep -rn "<function-name>" tests/`
- If a new exported function has zero test references: **P1 — add tests before merge**

### MCP Protocol Conformance

Verify the MCP server produces spec-compliant responses:

```bash
# 1. Initialize response must contain ONLY: protocolVersion, capabilities, serverInfo
INIT_RESPONSE=$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"conformance-test","version":"1.0.0"}}}' | timeout 10 node dist/cli/index.js serve 2>/dev/null | head -1)
INIT_KEYS=$(echo "$INIT_RESPONSE" | jq -r '.result | keys | sort | join(",")')
echo "Initialize result keys: $INIT_KEYS"
# MUST be exactly: capabilities,protocolVersion,serverInfo (no instructions or other fields)

# 2. All tool inputSchemas use only basic JSON Schema (no oneOf/anyOf/allOf at property level)
TOOLS_RESPONSE=$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | timeout 10 node dist/cli/index.js serve 2>/dev/null | tail -1)
NONSTANDARD_TOOLS=$(echo "$TOOLS_RESPONSE" | jq -r '[.result.tools[] | select(.inputSchema.properties | to_entries[]? | .value | (has("oneOf") or has("anyOf") or has("allOf")))] | length')
echo "Tools with non-standard schemas: $NONSTANDARD_TOOLS"
# MUST be 0

# 3. serverInfo.version matches package.json version
SERVER_VERSION=$(echo "$INIT_RESPONSE" | jq -r '.result.serverInfo.version')
PACKAGE_VERSION=$(node -p "require('./package.json').version")
echo "Server version: $SERVER_VERSION, Package version: $PACKAGE_VERSION"
# MUST match
```

**Gate**: All 3 checks must pass. If any fail, fix before merging.

## STEP 6: Merge (MY PRs only)

Merge order:
- If PRs modify the same files -> merge base PR first, rebase dependent PRs
- If no conflicts -> merge in PR number order

For each MY PR:

```bash
gh pr merge <N> --merge --delete-branch
git checkout develop && git pull origin develop
npm run build                                          # verify after each merge
npm test                                               # verify tests pass after each merge
```

**Note**: All PRs target the `develop` branch (per CLAUDE.md). To cut a release, merge `develop` into `main` after all PRs are merged and the build is green:

```bash
git checkout main && git pull origin main
git merge develop --no-ff -m "chore: merge develop into main for release"
git push origin main
```

Do NOT merge OTHER's PRs unless the user explicitly says to.

### Post-Merge Issue Verification (NEW — prevents "merged but incomplete")

After ALL PRs for an issue are merged, re-run the STEP 0 verification:

```bash
# Re-check the Coverage Matrix from STEP 0
# Every requirement should now be PASS
# If any requirement is still PARTIAL/MISSING/UNTESTED: DO NOT close the issue
```

If requirements remain incomplete after all PRs are merged:
1. Create new PRs for the remaining work
2. Update the issue with a status comment listing what's done and what's pending
3. Do NOT close the issue until ALL requirements are verified as PASS

## STEP 7: Cleanup

```bash
git branch --merged develop | grep -v 'develop\|main' | xargs -r git branch -d
git branch -a
gh pr list --state open
npm run build
git log --oneline -10
```

## STEP 8: Publish (only if user requests)

### 8a. Verify CI passes on main

**CRITICAL**: Do NOT publish until CI is green on main.

```bash
# Wait for CI to complete after merging to main
gh run list --branch main --limit 1 --json status,conclusion,databaseId
# If status is "completed" and conclusion is "success", proceed.
# If status is "in_progress", wait and re-check.
# If conclusion is "failure", fix before publishing.
```

**Gate**: CI must pass (all 9 matrix jobs: 3 OS x 3 Node versions). Do NOT proceed if any job failed.

### 8b. Publish to npm

```bash
npm version patch   # or minor/major per user request
git push origin main --tags
gh release create v$(node -p "require('./package.json').version") --generate-notes
npm publish
```

Skip this step entirely unless the user explicitly asks for a version bump or publish.

### 8c. Post-publish: Local Environment Sync

**CRITICAL** — `npm publish` alone does NOT update the local environment.
Skipping this step causes version mismatch where the MCP server runs old code.

**Root cause**: `npx` caches a semver range (e.g. `^1.4.0`) in `~/.npm/_npx/<hash>/package-lock.json`.
Even with `@latest`, npx satisfies the range from its local cache without checking the registry.
You MUST clear this cache after every publish.

```bash
# 1. Kill ALL openchrome processes (parents AND node children)
pkill -f "openchrome-mcp" || true
pkill -f "_npx.*openchrome" || true
pkill -f "openchrome serve" || true
sleep 1
# Verify no survivors:
ps aux | grep -E "openchrome.*(serve|mcp)" | grep -v grep

# 2. Clear npx cache (prevents stale version serving)
rm -rf ~/.npm/_npx/*/node_modules/openchrome-mcp
rm -rf ~/.npm/_npx/*/package-lock.json

# 3. Update global npm package
npm install -g openchrome-mcp@latest

# 4. Re-run setup to apply --prefer-online flag (one-time fix for existing users)
npx --prefer-online openchrome-mcp@latest setup

# 5. Verify version consistency across all 5 paths
echo "src:    $(node -p \"require('./package.json').version\")" && \
echo "dist:   $(node dist/cli/index.js --version 2>/dev/null)" && \
echo "global: $(npm ls -g openchrome-mcp 2>/dev/null | grep openchrome)" && \
echo "npm:    $(npm view openchrome-mcp version)" && \
echo "npx:    $(npx --prefer-online openchrome-mcp --version 2>/dev/null)"
```

**Gate**: All 5 versions must match. If dist is outdated, run `npm run build` first.

After verification, the user must **restart Claude Code** for the new MCP server to take effect.

**For other users**: Users running `npx openchrome-mcp@latest serve` will auto-update if they have `--prefer-online` in their MCP config. Users with older configs should either:
1. Re-run `npx openchrome-mcp@latest setup` (writes the `--prefer-online` flag), or
2. Manually delete `~/.npm/_npx/` and restart Claude Code

---

## Completion Checklist

### Issue Verification (STEP 0)
- [ ] Requirements Matrix created for each target issue
- [ ] Coverage Matrix maps every requirement to a PR or code change
- [ ] No requirement is MISSING or PARTIAL — all accounted for
- [ ] Every requirement verified in actual code (not just PR diff)

### PR Review (STEP 4)
- [ ] Every open PR has a GitHub review comment posted
- [ ] Every PR passed deep code review (`/code-review-oc`) including platform specialist
- [ ] Greptile review checked and new findings addressed (if review available)
- [ ] **Issue-Requirement Verification**: Every PR implements its full claimed scope
- [ ] **Test Coverage**: Every new exported function/class has test references
- [ ] **Completeness Grep**: Changes applied to ALL required locations (not just some)

### Pre-merge (STEP 5)
- [ ] `npm ci` passes (lockfile in sync)
- [ ] `npm run build` passes
- [ ] `npm run lint` passes — no errors
- [ ] `npm test` passes — ALL test suites green
- [ ] Platform anti-pattern grep: all clean
- [ ] MCP Protocol: `initialize` response contains only `protocolVersion`, `capabilities`, `serverInfo`
- [ ] MCP Protocol: Tool schemas use only basic JSON Schema (no `oneOf`/`anyOf`/`allOf` in properties)
- [ ] MCP Protocol: `serverInfo.version` matches `package.json` version

### Merge & Post-merge (STEP 6)
- [ ] All MY PRs: P0 = 0, P1 = 0, merged
- [ ] All OTHER's PRs: reviewed and commented (NOT merged)
- [ ] **Post-merge issue verification**: Re-checked Coverage Matrix, all requirements PASS
- [ ] Issues with incomplete requirements: NOT closed, status comment posted

### Cleanup (STEP 7)
- [ ] No unnecessary branches remain
- [ ] Working tree is clean
- [ ] Build passes on develop

### Publish (STEP 8, if applicable)
- [ ] CI green on main before publish (all 9 matrix jobs)
- [ ] Global npm package matches published version
- [ ] npx cache cleared (`~/.npm/_npx/*/node_modules/openchrome-mcp` removed)
- [ ] No zombie MCP server processes running old version
