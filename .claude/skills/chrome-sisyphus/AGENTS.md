# Chrome-Sisyphus Agent Specifications

에이전트 역할, 모델, 프롬프트 템플릿을 정의합니다.

---

## Agent Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR (Main Session)                   │
│                  Task Decomposition & Coordination               │
├─────────────────────────────────────────────────────────────────┤
│              ┌───────────────┼───────────────┐                   │
│              ↓               ↓               ↓                   │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐        │
│  │ WORKER AGENT  │  │ WORKER AGENT  │  │ WORKER AGENT  │        │
│  │  (Background) │  │  (Background) │  │  (Background) │        │
│  │   Sonnet      │  │   Sonnet      │  │   Sonnet      │        │
│  └───────────────┘  └───────────────┘  └───────────────┘        │
│              └───────────────┼───────────────┘                   │
│                              ↓                                   │
│                    ┌───────────────┐                             │
│                    │  COORDINATOR  │                             │
│                    │   (Inline)    │                             │
│                    └───────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Orchestrator (Main Session)

**Role**: 작업 분해, 워커 할당, 상태 모니터링

### Decomposition Algorithm

```
Input: "구글, 아마존, 네이버에서 '노트북' 검색해줘"

Analysis:
├── Sites: [google.com, amazon.com, naver.com]
├── Parallelizable: Yes
└── Dependencies: None

Output:
├── Worker 1: google → search → extract
├── Worker 2: amazon → search → extract
└── Worker 3: naver → search → extract
```

---

## 2. Worker Agent (Background Task)

**Model**: sonnet
**Execution**: `run_in_background: true`

### Key Rules
1. Always include tabId in every MCP tool call
2. Update scratchpad after every action
3. Maximum 5 iterations (Ralph Loop)
4. Return compressed result only

### Available Tools
- navigate, computer, read_page, find, form_input, javascript_tool

### Final Output Format
```
---RESULT---
{
  "status": "SUCCESS" | "PARTIAL" | "FAIL",
  "workerName": "{name}",
  "resultSummary": "Brief summary (100 chars)",
  "dataExtracted": { ... },
  "EXIT_SIGNAL": true
}
---END---
```

---

## 3. Coordinator (Inline)

**Role**: 결과 통합, 보고서 생성

### Process
1. Collect results from all workers
2. Normalize data formats
3. Generate comparison/summary
4. Present to user

---

## Context Budget

| Component | Max Tokens |
|-----------|------------|
| Orchestrator | ~500 |
| Status check | ~200/worker |
| Result integration | ~300/worker |
| **Total (5 workers)** | **~2000** |
