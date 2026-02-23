# /chrome-sisyphus Command

Chrome-Parallel 기반 브라우저 오케스트레이션 명령어입니다.

---

## Usage

```
/chrome-sisyphus <task_description>
```

## Examples

```
/chrome-sisyphus 쿠팡, 11번가에서 아이폰 15 가격 비교해줘
/chrome-sisyphus 네이버, 다음 뉴스에서 AI 관련 기사 수집해줘
/chrome-sisyphus 3개 쇼핑몰에서 노트북 검색하고 상위 5개 정보 추출해줘
```

---

## Execution Flow

When `/chrome-sisyphus` is invoked, follow this orchestration protocol:

### Phase 1: Setup & Decomposition

```markdown
1. **Create Scratchpad Directory**
   - Create `.agent/chrome-sisyphus/` directory using Bash
   - Initialize `orchestration.md` file

2. **Decompose Task**
   - Analyze user request
   - Identify target sites
   - Define worker tasks
   - Set success criteria
```

### Phase 2: Worker Creation

```markdown
3. **Create Browser Tabs**
   For each worker:
   - Call `mcp__chrome-parallel__tabs_create_mcp` to create a new tab
   - Store the tabId for the worker

4. **Initialize Worker Scratchpads**
   - Create `.agent/chrome-sisyphus/worker-{name}.md` for each worker
   - Initialize with task details
```

### Phase 3: Parallel Execution

```markdown
5. **Launch Background Tasks**
   For each worker (in parallel):
   - Use Task tool with `run_in_background: true`
   - Pass worker configuration and tab ID
   - Workers execute independently

6. **Monitor Progress**
   - Periodically check worker Scratchpad files
   - Update orchestration.md with status
   - Report progress to user
```

### Phase 4: Result Collection

```markdown
7. **Collect Results**
   - Wait for all Background Tasks to complete
   - Read final results from each worker
   - Handle failures gracefully

8. **Coordinate Results**
   - Use Coordinator agent to integrate results
   - Generate unified report
   - Present to user
```

---

## Implementation Template

When `/chrome-sisyphus` is invoked, execute this:

```markdown
## Step 1: Initialize

Create the working directory:
```bash
mkdir -p .agent/chrome-sisyphus
```

## Step 2: Decompose Task

Analyze: "{user_task}"

Decomposition result:
- Workers needed: {n}
- Sites: {site_list}
- Strategy: parallel/sequential

## Step 3: Create Tabs

For each worker, create a tab:
```
mcp__chrome-parallel__tabs_create_mcp
→ Returns: { tabId: "target-xxx" }
```

## Step 4: Launch Workers

Launch each worker as a Background Task:

```
Task(
  subagent_type="general-purpose",
  model="sonnet",
  run_in_background=true,
  prompt="[Worker Agent] ...",
  description="Worker {name}: {task}"
)
```

## Step 5: Monitor & Collect

Check status periodically:
- Read Scratchpad files
- Report progress
- Wait for completion

## Step 6: Integrate Results

Use Coordinator to generate final report.
```

---

## Important Notes

### Context Isolation
- Each worker runs in Background Task (isolated context)
- Main session stays light (~2000 tokens)
- No screenshot/DOM accumulation in main context

### Error Handling
- Workers retry up to 5 times (Ralph Loop)
- Partial results are reported
- Failed workers don't block others

### Limits
- Max 5 concurrent workers
- 5 iterations per worker
- 5-minute timeout per worker

---

## Skill Reference

For detailed agent specifications, see:
- `.claude/skills/chrome-sisyphus/SKILL.md` - Overview
- `.claude/skills/chrome-sisyphus/AGENTS.md` - Agent specs
- `.claude/skills/chrome-sisyphus/agents/` - Individual agents
