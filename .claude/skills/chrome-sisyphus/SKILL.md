# Chrome-Sisyphus Skill

Chrome-Parallel MCP 서버를 활용한 브라우저 오케스트레이션 스킬입니다.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    CHROME-SISYPHUS                               │
│         Browser Orchestration with Context Isolation             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User: "쿠팡, 11번가에서 아이폰 가격 비교해줘"                    │
│                              ↓                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              ORCHESTRATOR (Main Session)                  │   │
│  │  - Task Decomposition                                     │   │
│  │  - Worker Allocation                                      │   │
│  │  - Status Monitoring (~500 tokens)                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↓                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ Background  │  │ Background  │  │ Background  │             │
│  │ Task Agent  │  │ Task Agent  │  │ Task Agent  │             │
│  │ (Worker 1)  │  │ (Worker 2)  │  │ (Worker 3)  │             │
│  │ Coupang     │  │ 11st        │  │ Gmarket     │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│         ↓                ↓                ↓                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ Scratchpad  │  │ Scratchpad  │  │ Scratchpad  │             │
│  │ worker-1.md │  │ worker-2.md │  │ worker-3.md │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Trigger

- Command: `/chrome-sisyphus`
- Natural language: "브라우저로 ~", "여러 사이트에서 ~", "가격 비교해줘" 등

---

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `mcp__openchrome__navigate` | URL 이동 |
| `mcp__openchrome__computer` | 클릭, 타이핑, 스크린샷 |
| `mcp__openchrome__read_page` | 페이지 구조 읽기 |
| `mcp__openchrome__find` | 요소 검색 |
| `mcp__openchrome__form_input` | 폼 입력 |
| `mcp__openchrome__javascript_tool` | JS 실행 |
| `mcp__openchrome__tabs_create_mcp` | 새 탭 생성 |
| `mcp__openchrome__tabs_context_mcp` | 탭 컨텍스트 조회 |
| `mcp__openchrome__worker_create` | 워커 생성 |
| `mcp__openchrome__worker_list` | 워커 목록 |
| `mcp__openchrome__worker_delete` | 워커 삭제 |
| `mcp__openchrome__network` | 네트워크 조건 설정 |

---

## Context Management Strategy

### Problem: Context Explosion in Single Session

```
❌ Without isolation:
Main Session Context
├── Worker 1 screenshot (large)
├── Worker 1 DOM tree (large)
├── Worker 2 screenshot (large)
├── Worker 2 DOM tree (large)
└── ... (Context explosion!)
```

### Solution: Background Task + File-based State

```
✅ With isolation:
Main Session (~500 tokens)
├── Task decomposition summary
├── Worker ID list
└── Status summary only

Background Tasks (isolated contexts)
├── Worker 1: own screenshots/DOM (not in main)
├── Worker 2: own screenshots/DOM (not in main)
└── Worker 3: own screenshots/DOM (not in main)

Scratchpad Files (persistent state)
├── .agent/chrome-sisyphus/orchestration.md
├── .agent/chrome-sisyphus/worker-1.md
├── .agent/chrome-sisyphus/worker-2.md
└── .agent/chrome-sisyphus/worker-3.md
```

---

## Execution Phases

### Phase 1: Setup & Decomposition

1. Create working directory: `mkdir -p .agent/chrome-sisyphus`
2. Analyze user request (sites, tasks, criteria)
3. Create orchestration.md with plan

### Phase 2: Worker Creation

4. For each worker:
   - Create isolated browser context (worker_create)
   - Create tab (tabs_create_mcp)
   - Initialize worker scratchpad

### Phase 3: Parallel Execution

5. Launch Background Tasks (in parallel!)
6. Workers execute independently with Ralph Loop

### Phase 4: Result Collection

7. Monitor completion via TaskOutput
8. Integrate results and report to user

---

## Limits & Safety

| Limit | Value | Reason |
|-------|-------|--------|
| Max concurrent workers | 5 | Resource protection |
| Max iterations per worker | 5 | Prevent infinite loops |
| Consecutive error threshold | 3 | Circuit breaker |
| Task timeout | 5 minutes | Resource protection |

---

## Agent Specifications

See `AGENTS.md` for detailed agent definitions.
