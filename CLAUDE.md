# Claude Code Project Instructions

## Trinity Project

**Repository**: https://github.com/shaun0927/trinity
**PR Target Branch**: `develop`

Trinity 관련 코드 수정 시 반드시 위 레포지토리의 develop 브랜치로 PR을 생성할 것.

## Browser Tool Usage

This project provides browser automation tools (openchrome).

**Use browser tools ONLY when:**
- User explicitly requests browser/UI interaction
- Visual verification or screenshot is needed
- No API/DB alternative exists

**Prefer these approaches first:**
1. Code analysis → Read files directly
2. Data operations → DB queries
3. API testing → `curl` command
4. Config changes → Edit files directly

Browser automation has high context usage. Use as last resort.

## Parallel Browser Workflow

When 2+ independent browser tasks are requested with parallel intent ("동시에", "병렬로", "parallel"):
1. `workflow_init` → create workers with dedicated tabs
2. Spawn background Task agents (each gets hardcoded `tabId` to prevent cross-tab contamination)
3. `workflow_collect` → unify results

MCP responses include `_timing.durationMs` for wall-clock performance measurement.
