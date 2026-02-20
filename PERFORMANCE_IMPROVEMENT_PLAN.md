# CCP (Claude Chrome Parallel) 성능 개선 계획

> **문서 버전**: 1.0
> **작성일**: 2026-02-21
> **기준 실험**: 20개 X(Twitter) 프로필 병렬 크롤링
> **총 소요 시간**: 375.6초

---

## 1. 현황 요약 (Executive Summary)

### 1.1 측정된 병목 현황

20개 워커를 활용한 병렬 크롤링 실험에서 전체 375.6초 중 각 단계별 소요 시간은 다음과 같다:

| 단계 | 설명 | 소요 시간 | 비율 |
|------|------|-----------|------|
| Phase 1 | workflow_init (탭 20개 + 워커 생성) | 37.2초 | 9.9% |
| Phase 2 | 에이전트 스폰 (haiku 에이전트 20개) | 109.0초 | 29.0% |
| Phase 3 | 병렬 실행 (실제 크롤링) | 214.3초 | 57.1% |
| Phase 4 | workflow_collect | 15.1초 | 4.0% |
| **합계** | | **375.6초** | 100% |

**핵심 관찰 사항:**
- 워커당 실제 작업 시간: 평균 5.69초 (극히 짧음)
- 에이전트 스폰 오버헤드: 워커당 평균 5.45초 → 전체의 29%를 낭비
- 이상 워커 발생: JeffBezos 워커가 455초 소요 (`computer(scroll)` 스크린샷 타임아웃 185초/회)
- Phase 3의 57.1%는 이상 워커 1개가 지배적 영향을 미침

### 1.2 핵심 문제 요약

1. **에이전트 스폰 오버헤드**: 실제 작업보다 오버헤드가 더 큰 구조적 비효율
2. **스크린샷 포함 스크롤**: `computer(scroll)`이 불필요하게 스크린샷을 캡처하여 고부하 시 심각한 지연 발생
3. **런어웨이 워커 무방비**: 단일 워커가 전체 워크플로우를 수백 초 지연시킬 수 있음
4. **커넥션 풀 사전 워밍 부족**: 20개 워커 대비 5개만 사전 준비
5. **순차적 탭 내비게이션**: 병렬화 가능한 작업이 직렬로 수행됨

### 1.3 목표 개선치

| 단계 | 현재 | 목표 (P0 적용 후) | 목표 (전체 적용 후) |
|------|------|-------------------|---------------------|
| Phase 1 | 37.2초 | 22초 | 15초 |
| Phase 2 | 109.0초 | ~0초 | ~0초 |
| Phase 3 | 214.3초 | 50초 | 30초 |
| Phase 4 | 15.1초 | 15초 | 5초 |
| **합계** | **375.6초** | **~87초** | **~50초** |
| **개선율** | | **약 77% 단축** | **약 87% 단축** |

---

## 2. 개선 항목 (Improvement Items)

---

### 2.1 [P0] 경량 배치 실행 모드 — 에이전트 스폰 오버헤드 제거

#### 문제 정의

20개의 에이전트를 스폰하는 데 109초가 소요된다. 워커당 평균 실제 작업 시간이 5.69초에 불과하다는 점을 고려하면, 스폰 오버헤드(109초)가 실제 유용한 작업(~114초)과 맞먹는 수준의 낭비다. 에이전트 스폰 비용은 실제 가치와 무관하게 고정 비용으로 발생한다.

#### 근본 원인

현재 아키텍처는 "에이전트당 하나의 탭"을 전제로 설계되어 있다. 각 Claude 에이전트 인스턴스는 독립적인 LLM 컨텍스트와 MCP 연결을 초기화해야 하며, 이 초기화 과정 자체가 ~5.5초/워커의 고정 비용을 발생시킨다. 단순한 데이터 추출 작업(JS로 충분히 처리 가능)에도 무거운 에이전트 인프라를 사용하는 것이 비효율의 근원이다.

#### 개선 방안

MCP 서버 측에서 여러 탭에 걸쳐 스크립트를 병렬 실행하는 `batch_execute` 도구를 신설한다. 오케스트레이터(메인 Claude 세션)가 단일 MCP 도구 호출로 N개 탭에서 동시에 작업을 수행할 수 있게 한다. 에이전트 스폰 비용을 완전히 제거한다.

#### 구현 상세

**신규 파일**: `src/tools/batch-execute.ts`

```typescript
interface BatchExecuteInput {
  tasks: Array<{
    tabId: string;
    workerId: string;
    script: string;           // 탭 내에서 실행할 JavaScript
    timeout?: number;         // ms 단위, 기본값 30000
  }>;
  concurrency?: number;       // 동시 실행 수, 기본값 10
  failFast?: boolean;         // 하나 실패 시 전체 중단 여부, 기본값 false
}

interface BatchExecuteOutput {
  results: Array<{
    tabId: string;
    workerId: string;
    success: boolean;
    data?: unknown;
    error?: string;
    durationMs: number;
  }>;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    totalDurationMs: number;
    wallClockDurationMs: number;
  };
}

// 핵심 구현 로직
async function batchExecute(input: BatchExecuteInput): Promise<BatchExecuteOutput> {
  const limiter = pLimit(input.concurrency ?? 10);
  const startTime = Date.now();

  const results = await Promise.all(
    input.tasks.map(task =>
      limiter(async () => {
        const taskStart = Date.now();
        try {
          const page = await sessionManager.getPageForTab(task.tabId);
          const data = await page.evaluate(task.script, {
            timeout: task.timeout ?? 30000,
          });
          return {
            tabId: task.tabId,
            workerId: task.workerId,
            success: true,
            data,
            durationMs: Date.now() - taskStart,
          };
        } catch (error) {
          return {
            tabId: task.tabId,
            workerId: task.workerId,
            success: false,
            error: String(error),
            durationMs: Date.now() - taskStart,
          };
        }
      })
    )
  );

  return {
    results,
    summary: {
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
      wallClockDurationMs: Date.now() - startTime,
    },
  };
}
```

**수정 파일**: `src/tools/index.ts`
- `batch_execute` 도구를 MCP 도구 목록에 등록

**수정 파일**: `src/session-manager.ts`
- `getPageForTab(tabId: string): Promise<Page>` 메서드 추가 (탭 ID로 기존 페이지 조회)

**사용 패턴 예시:**
```javascript
// 기존 방식: 20개 에이전트 스폰 → 109초
// 새 방식: 단일 batch_execute 호출 → ~5초 (병렬 JS 실행)

const result = await batch_execute({
  tasks: workers.map(w => ({
    tabId: w.tabId,
    workerId: w.workerId,
    script: `
      return {
        name: document.querySelector('[data-testid="UserName"]')?.textContent,
        followers: document.querySelector('[href$="/followers"] span')?.textContent,
        // ... 기타 필드
      };
    `,
  })),
  concurrency: 20,
});
```

#### 기대 효과

- Phase 2 (에이전트 스폰): 109초 → ~0초 (에이전트 스폰 불필요)
- Phase 3 (실행): JS 실행 기준 워커당 ~100ms, 20개 병렬 시 총 ~1-2초
- **전체 예상 개선**: 375초 → ~67초 (약 82% 단축)
- 스케일 불변: 워커 수가 50개로 늘어도 스폰 비용이 0에 수렴

#### 우선순위

**P0 (Critical)** — 단일 최대 임팩트 개선 항목

#### 구현 난이도

**Medium** — 새 MCP 도구 작성, 세션 매니저 수정 필요. 기존 아키텍처 변경 없음.

#### 영향 범위

JavaScript로 표현 가능한 모든 데이터 추출 워크플로우. 스크롤, 클릭, 폼 입력이 필요 없는 정적 페이지 추출 시나리오에 최적.

---

### 2.2 [P0] 경량 스크롤 — 스크린샷 없는 스크롤 분리

#### 문제 정의

`computer(scroll)` 호출 한 번이 정상 조건에서 약 200ms, 20개 탭 고부하 조건에서 최대 185초를 소요했다. JeffBezos 워커는 이 타임아웃으로 인해 455초를 소비했다. 스크롤 동작 자체에 스크린샷이 필요 없음에도 불구하고 현재 구현은 스크롤마다 스크린샷을 캡처한다.

#### 근본 원인

`src/tools/computer.ts`의 `scroll` 액션은 `screenshot` 액션과 동일한 코드 경로를 공유한다. 스크롤 후 화면 상태를 "확인"하기 위해 스크린샷을 캡처하는 것이 기본 동작이다. 20개 탭이 동시에 스크린샷을 요청하면 CDP의 `Page.captureScreenshot` 호출이 직렬화되어 큐잉 지연이 기하급수적으로 증가한다.

JavaScript의 `window.scrollBy()`는 스크린샷 없이 2ms 이내에 완료되므로, 스크롤 전용 경량 경로를 분리하면 타임아웃 위험을 완전히 제거할 수 있다.

#### 개선 방안

두 가지 접근을 병행 적용한다:

1. **`computer.ts` 수정**: `scroll` 액션에 `skipScreenshot: true` 옵션 추가
2. **신규 `lightweight_scroll` 도구**: 스크롤 전용 MCP 도구로 스크린샷 없이 CDP Input 이벤트 또는 JS로만 동작

#### 구현 상세

**수정 파일**: `src/tools/computer.ts`

```typescript
// 기존 scroll 핸들러 수정
async function handleScroll(params: ScrollParams, options: ComputerOptions) {
  const { x, y, direction, amount, tabId } = params;
  const skipScreenshot = options.skipScreenshot ?? false;

  // 방법 1: JavaScript scrollBy (권장 - 타임아웃 없음)
  if (options.useJsScroll ?? true) {
    const scrollY = direction === 'down' ? amount * 100 : -amount * 100;
    const scrollX = direction === 'right' ? amount * 100 : direction === 'left' ? -amount * 100 : 0;
    await page.evaluate(`window.scrollBy(${scrollX}, ${scrollY})`);
  } else {
    // 방법 2: CDP Input.dispatchMouseEvent (마우스 휠 이벤트)
    await cdpClient.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x, y,
      deltaX: direction === 'right' ? amount * 100 : direction === 'left' ? -amount * 100 : 0,
      deltaY: direction === 'down' ? amount * 100 : -amount * 100,
    });
  }

  // skipScreenshot 옵션 시 스크린샷 생략
  if (skipScreenshot) {
    return { success: true, scrolled: true };
  }

  // 기존 스크린샷 캡처 로직 (기본 동작 유지)
  return await captureScreenshot(tabId);
}
```

**신규 파일**: `src/tools/lightweight-scroll.ts`

```typescript
interface LightweightScrollInput {
  tabId: string;
  direction: 'up' | 'down' | 'left' | 'right';
  amount?: number;       // 픽셀 단위, 기본값 300
  smooth?: boolean;      // smooth scrolling, 기본값 false
  selector?: string;     // 특정 요소 스크롤 (기본값: window)
}

interface LightweightScrollOutput {
  success: boolean;
  scrollX: number;
  scrollY: number;
  durationMs: number;
}

async function lightweightScroll(input: LightweightScrollInput): Promise<LightweightScrollOutput> {
  const { tabId, direction, amount = 300, smooth = false, selector } = input;
  const start = Date.now();

  const page = await sessionManager.getPageForTab(tabId);

  const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
  const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0;

  const scrollResult = await page.evaluate(
    `(function() {
      const target = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'window'};
      if (!target) return { error: 'selector not found' };
      target.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: '${smooth ? 'smooth' : 'instant'}' });
      return { scrollX: window.scrollX, scrollY: window.scrollY };
    })()`
  );

  return {
    success: true,
    scrollX: scrollResult.scrollX,
    scrollY: scrollResult.scrollY,
    durationMs: Date.now() - start,
  };
}
```

**수정 파일**: `src/tools/index.ts`
- `lightweight_scroll` 도구 등록

#### 기대 효과

- 스크롤 1회당: 185초(타임아웃) → <5ms (JS 실행)
- JeffBezos류 이상 워커: 455초 → ~15초 (순수 작업 시간)
- 20탭 고부하 환경에서 CDP 스크린샷 큐 경합 완전 해소
- **전체 예상 개선**: Phase 3 런어웨이 워커 시나리오 제거로 214초 → ~50초

#### 우선순위

**P0 (Critical)** — 이상 워커 타임아웃의 직접적 원인 해소

#### 구현 난이도

**Low** — `computer.ts` 옵션 추가 및 단순 JS 래퍼 작성. 기존 코드 최소 수정.

#### 영향 범위

스크롤을 포함하는 모든 워크플로우. 특히 무한 스크롤 페이지(소셜 미디어, 뉴스 피드 등) 크롤링 시 결정적 효과.

---

### 2.3 [P1] 병렬 스크린샷 파이프라인 — 스크린샷 동시성 제어

#### 문제 정의

20개 워커가 동시에 `computer()` 스크린샷을 요청할 때, CDP의 `Page.captureScreenshot`이 실질적으로 직렬화된다. 각 스크린샷 캡처가 약 200ms라면 이론적 병렬 처리 시 200ms이어야 하지만, 20개 동시 요청 시 최악 4000ms(20 × 200ms)의 큐 지연이 발생한다.

#### 근본 원인

현재 구현(`src/tools/computer.ts`)은 스크린샷 요청에 대한 동시성 제어 메커니즘이 없다. CDP 연결은 탭별로 분리되어 있으나, 브라우저 렌더러 프로세스의 스크린샷 캡처 능력 자체가 제한적이다. 특히 동일한 Chrome 인스턴스에서 여러 탭의 스크린샷을 동시에 요청하면 GPU/렌더러 자원을 놓고 경합이 발생한다.

#### 개선 방안

`ScreenshotScheduler` 클래스를 도입하여 스크린샷 요청을 큐에 넣고, 설정 가능한 동시성 한도(기본 5개) 내에서 병렬 처리한다. 무제한 동시 실행보다 제어된 병렬 처리가 총 처리량을 높인다.

#### 구현 상세

**신규 파일**: `src/cdp/screenshot-scheduler.ts`

```typescript
import pLimit from 'p-limit';

interface ScreenshotRequest {
  tabId: string;
  quality?: number;
  fullPage?: boolean;
  resolve: (result: ScreenshotResult) => void;
  reject: (error: Error) => void;
  queuedAt: number;
}

interface ScreenshotResult {
  data: string;         // base64 WebP
  width: number;
  height: number;
  durationMs: number;
  waitMs: number;       // 큐 대기 시간
}

export class ScreenshotScheduler {
  private limiter: pLimit.Limit;
  private pendingCount = 0;
  private completedCount = 0;

  constructor(
    private readonly cdpClientFactory: (tabId: string) => CDPClient,
    private readonly concurrency: number = 5  // 기본값 5 (실험적 최적값)
  ) {
    this.limiter = pLimit(concurrency);
  }

  async capture(tabId: string, quality = 60, fullPage = false): Promise<ScreenshotResult> {
    const queuedAt = Date.now();
    this.pendingCount++;

    return this.limiter(async () => {
      const waitMs = Date.now() - queuedAt;
      const captureStart = Date.now();

      try {
        const client = this.cdpClientFactory(tabId);
        const { data } = await client.send('Page.captureScreenshot', {
          format: 'webp',
          quality,
          captureBeyondViewport: fullPage,
        });

        this.completedCount++;
        return {
          data,
          width: 0,   // CDP 응답에서 채움
          height: 0,
          durationMs: Date.now() - captureStart,
          waitMs,
        };
      } finally {
        this.pendingCount--;
      }
    });
  }

  getStats() {
    return {
      pending: this.pendingCount,
      completed: this.completedCount,
      concurrency: this.concurrency,
    };
  }
}
```

**수정 파일**: `src/tools/computer.ts`

```typescript
// ScreenshotScheduler를 싱글톤으로 주입
import { ScreenshotScheduler } from '../cdp/screenshot-scheduler';

// 환경변수 또는 config로 동시성 설정
const scheduler = new ScreenshotScheduler(
  (tabId) => sessionManager.getCdpClient(tabId),
  parseInt(process.env.SCREENSHOT_CONCURRENCY ?? '5')
);

// 기존 스크린샷 로직 교체
async function captureScreenshot(tabId: string, options: ScreenshotOptions) {
  return scheduler.capture(tabId, options.quality ?? 60, options.fullPage ?? false);
}
```

**수정 파일**: `src/server.ts` 또는 설정 파일
```
SCREENSHOT_CONCURRENCY=8  # 워커 수의 40% 수준 권장
```

#### 기대 효과

- 20개 동시 스크린샷 요청: 무제한 경합 → 5개씩 순서대로 처리
- 총 처리 시간: 20 × 200ms(직렬) = 4000ms → ceil(20/5) × 200ms = 800ms (5배 개선)
- GPU/렌더러 자원 경합 감소로 개별 스크린샷 품질 및 성공률 향상
- **예상 개선**: 스크린샷 집중 워크플로우에서 3-5배 처리량 증가

#### 우선순위

**P1 (High)** — 스크린샷을 많이 사용하는 시나리오에서 고효과

#### 구현 난이도

**Low** — p-limit 기반 단순 래퍼. 기존 코드 최소 변경.

#### 영향 범위

`computer()` 도구를 사용하는 모든 워크플로우. 특히 고해상도 스크린샷이나 전체 페이지 캡처가 필요한 시나리오.

---

### 2.4 [P1] 스마트 워커 타임아웃 및 서킷 브레이커

#### 문제 정의

JeffBezos 워커는 16번의 도구 호출을 수행하며 455초를 소비했으나, 처음 5초 이후 실질적인 데이터 추출을 달성하지 못했다. 현재 아키텍처에는 "진행 없는 워커"를 감지하고 중단시키는 메커니즘이 전혀 없다. 단일 이상 워커가 `workflow_collect`의 완료를 수백 초 지연시킬 수 있다.

#### 근본 원인

`src/orchestration/workflow-engine.ts`의 워커 상태 관리는 데이터 수집 여부와 무관하게 워커가 실행 중인 한 무한 대기한다. 워커의 `extractedData`가 변경되지 않더라도 타임아웃이나 중단 신호가 없다. LLM 에이전트가 반복적으로 스크롤-스크린샷 루프에 빠지면 외부에서 개입할 방법이 없다.

#### 개선 방안

두 가지 메커니즘을 조합한다:

1. **절대 타임아웃**: 워커당 최대 실행 시간 설정 (예: `maxDurationMs: 30000`)
2. **진행 기반 서킷 브레이커**: `extractedData` 해시가 N회 연속 변경 없으면 자동 완료

#### 구현 상세

**수정 파일**: `src/orchestration/workflow-engine.ts`

```typescript
interface WorkerConfig {
  workerId: string;
  tabId: string;
  url: string;
  maxDurationMs?: number;       // 기본값 60000 (60초)
  maxStaleIterations?: number;  // 기본값 5 (5회 연속 데이터 미변경)
}

interface WorkerRuntimeState {
  startTime: number;
  lastDataHash: string;
  staleCount: number;
  status: 'running' | 'completed' | 'timeout' | 'stale' | 'error';
}

class WorkflowEngine {
  private workerStates = new Map<string, WorkerRuntimeState>();
  private timeoutHandles = new Map<string, NodeJS.Timeout>();

  async createWorker(config: WorkerConfig): Promise<void> {
    const maxDuration = config.maxDurationMs ?? 60_000;

    // 절대 타임아웃 등록
    const timeoutHandle = setTimeout(() => {
      this.forceCompleteWorker(config.workerId, 'timeout', {
        reason: `MaxDuration ${maxDuration}ms exceeded`,
        partial: true,
      });
    }, maxDuration);

    this.timeoutHandles.set(config.workerId, timeoutHandle);
    this.workerStates.set(config.workerId, {
      startTime: Date.now(),
      lastDataHash: '',
      staleCount: 0,
      status: 'running',
    });
  }

  async onWorkerUpdate(workerId: string, extractedData: unknown): Promise<void> {
    const state = this.workerStates.get(workerId);
    if (!state) return;

    const config = this.getWorkerConfig(workerId);
    const maxStale = config.maxStaleIterations ?? 5;

    const newHash = this.hashData(extractedData);

    if (newHash === state.lastDataHash) {
      state.staleCount++;
      if (state.staleCount >= maxStale) {
        await this.forceCompleteWorker(workerId, 'stale', {
          reason: `No data change for ${maxStale} iterations`,
          partial: true,
        });
      }
    } else {
      state.staleCount = 0;
      state.lastDataHash = newHash;
    }
  }

  private async forceCompleteWorker(
    workerId: string,
    reason: 'timeout' | 'stale',
    meta: { partial: boolean; reason: string }
  ): Promise<void> {
    const handle = this.timeoutHandles.get(workerId);
    if (handle) clearTimeout(handle);

    await this.updateWorkerStatus(workerId, 'PARTIAL_COMPLETE', {
      completionReason: reason,
      ...meta,
    });

    this.emit('workerForceCompleted', { workerId, reason });
  }

  private hashData(data: unknown): string {
    return JSON.stringify(data).length.toString() +
      '_' +
      (JSON.stringify(data) ?? '').slice(0, 100);
  }
}
```

**수정 파일**: `src/tools/orchestration.ts`

```typescript
// workflow_init 파라미터에 글로벌 타임아웃 추가
interface WorkflowInitInput {
  workers: WorkerConfig[];
  globalTimeoutMs?: number;     // 전체 워크플로우 타임아웃, 기본 300000 (5분)
  workerTimeoutMs?: number;     // 개별 워커 기본 타임아웃, 기본 60000 (60초)
  maxStaleIterations?: number;  // 기본값 5
}
```

**수정 파일**: `src/tools/worker-update.ts`

```typescript
// worker_update 호출 시마다 서킷 브레이커 체크
async function handleWorkerUpdate(input: WorkerUpdateInput): Promise<void> {
  await workflowEngine.onWorkerUpdate(input.workerId, input.extractedData);
  // ... 기존 로직
}
```

#### 기대 효과

- JeffBezos류 런어웨이 워커: 455초 → 최대 60초 (설정값)
- 전체 워크플로우 최악 시나리오: 1개 이상 워커 → 즉각 격리
- Phase 3: 214초 → 60초 이하 (절대 타임아웃 기준)
- 부분 결과 수집 가능 → 이상 워커도 수집된 데이터 활용

#### 우선순위

**P1 (High)** — 최악 시나리오 방어의 핵심

#### 구현 난이도

**Medium** — 상태 관리 로직 수정, 타임아웃 핸들 추적. 기존 워크플로우 엔진 내 변경.

#### 영향 범위

모든 다중 워커 워크플로우. 특히 외부 네트워크 의존성이 있거나 페이지 로딩 시간이 불확실한 시나리오.

---

### 2.5 [P1] 적응형 커넥션 풀 사이즈 — 워크플로우 기반 사전 워밍

#### 문제 정의

커넥션 풀은 항상 5개의 페이지를 사전 준비(`minPoolSize=5`)한다. 20개 워커를 사용하는 워크플로우가 시작되면, 15개의 추가 페이지를 워커 생성 루프 중에 실시간으로 생성해야 한다. 이 지연이 Phase 1의 37.2초 중 상당 부분을 차지한다.

#### 근본 원인

`src/cdp/connection-pool.ts`의 사전 워밍 로직은 전역 `minPoolSize` 설정에만 의존하고, 임박한 워크플로우의 수요를 예측하지 않는다. `workflow_init`이 호출될 때 이미 최소 풀만 준비된 상태이므로, 워커 생성 루프가 풀 확장을 기다리며 직렬화된다.

#### 개선 방안

`workflow_init`에서 워커 생성 루프를 시작하기 전에 `pool.preWarmForWorkflow(count)` 를 호출하여 필요한 수의 페이지를 미리 준비한다. 페이지 생성을 병렬화하여 사전 워밍 자체도 빠르게 완료한다.

#### 구현 상세

**수정 파일**: `src/cdp/connection-pool.ts`

```typescript
export class ConnectionPool {
  // 기존 메서드들...

  /**
   * 워크플로우를 위해 N개의 페이지를 사전 준비
   * workflow_init 호출 즉시 실행하여 워커 생성 전에 완료
   */
  async preWarmForWorkflow(count: number): Promise<void> {
    const currentAvailable = this.getAvailableCount();
    const needed = Math.max(0, count - currentAvailable);

    if (needed === 0) return;

    // 최대 풀 크기 임시 확장
    const targetSize = Math.min(
      this.currentPoolSize + needed,
      this.maxPoolSize  // maxPoolSize=25 준수
    );

    // 병렬 페이지 생성 (동시성 제한: 10)
    const limiter = pLimit(10);
    const createTasks = Array.from({ length: needed }, () =>
      limiter(() => this.createAndWarmPage())
    );

    await Promise.all(createTasks);
    this.currentPoolSize = targetSize;
  }

  private async createAndWarmPage(): Promise<Page> {
    const context = await this.browser.newContext({
      userAgent: this.config.userAgent,
      viewport: this.config.viewport,
    });
    const page = await context.newPage();

    // DNS 사전 해석 (기존 로직 재활용)
    if (this.config.preloadOrigins?.length) {
      await Promise.all(
        this.config.preloadOrigins.map(origin =>
          page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {})
        )
      );
    }

    this.pool.push(page);
    return page;
  }
}
```

**수정 파일**: `src/tools/orchestration.ts`

```typescript
async function handleWorkflowInit(input: WorkflowInitInput): Promise<WorkflowInitOutput> {
  const workerCount = input.workers.length;

  // 워커 생성 전에 먼저 사전 워밍 (병렬 실행)
  const [preWarmResult] = await Promise.all([
    connectionPool.preWarmForWorkflow(workerCount),
    // DNS 사전 해석도 병렬 실행
    dnsPreResolver.resolveAll(input.workers.map(w => new URL(w.url).hostname)),
  ]);

  // 이후 기존 워커 생성 루프 (이제 풀이 준비된 상태)
  const workers = await Promise.all(
    input.workers.map(config => createWorker(config))
  );

  return { workflowId, workers };
}
```

#### 기대 효과

- 풀 사전 워밍 병렬화: 기존 직렬 5개 → 병렬 20개 생성
- Phase 1 예상 단축: 37.2초 → ~22초 (약 40% 개선)
- 워커 생성 루프에서의 페이지 대기 시간 제거
- DNS 사전 해석과 동시 실행으로 추가 절약

#### 우선순위

**P1 (High)** — Phase 1 오버헤드의 직접 원인 해소

#### 구현 난이도

**Medium** — 커넥션 풀 내부 로직 수정. maxPoolSize 제약 내에서의 동적 관리.

#### 영향 범위

모든 다중 워커 워크플로우. 워커 수가 많을수록 효과 증대.

---

### 2.6 [P2] 추출 최적화 `read_page` 모드 — 선택자 기반 부분 트리 반환

#### 문제 정의

`read_page`는 전체 접근성 트리를 반환하며 출력 크기가 최대 50KB에 달한다. 데이터 추출 시 필요한 것은 특정 CSS 선택자에 해당하는 소수의 요소뿐이다. 불필요한 50KB 응답을 LLM이 파싱해야 하므로 토큰 낭비 및 처리 지연이 발생한다.

#### 근본 원인

`src/tools/read-page.ts`는 접근성 트리 전체를 `depth` 파라미터(8/5 제한)로만 제어한다. CSS 선택자로 특정 DOM 요소를 타겟팅하는 경로가 없어 모든 요청이 전체 트리 탐색으로 귀결된다.

#### 개선 방안

`read_page`에 `selector` 파라미터를 추가한다. 선택자가 제공되면 CDP `DOM.querySelector`로 대상 노드를 찾고 해당 서브트리만 반환한다. 전체 트리 탐색 없이 필요한 데이터만 추출한다.

#### 구현 상세

**수정 파일**: `src/tools/read-page.ts`

```typescript
interface ReadPageInput {
  tabId: string;
  selector?: string;           // CSS 선택자 (신규)
  selectorAll?: string;        // 다중 선택자 (신규) - 모든 매칭 요소 반환
  depth?: number;              // 기존 파라미터 (selector 없을 때만 적용)
  maxOutputBytes?: number;     // 기존 파라미터
}

async function readPage(input: ReadPageInput): Promise<ReadPageOutput> {
  if (input.selector || input.selectorAll) {
    return await readPageBySelector(input);
  }
  // 기존 전체 트리 로직
  return await readFullAccessibilityTree(input);
}

async function readPageBySelector(input: ReadPageInput): Promise<ReadPageOutput> {
  const { tabId, selector, selectorAll } = input;
  const client = sessionManager.getCdpClient(tabId);

  if (selectorAll) {
    // 다중 요소: DOM.querySelectorAll
    const { nodeIds } = await client.send('DOM.querySelectorAll', {
      nodeId: await getRootNodeId(client),
      selector: selectorAll,
    });

    const subtrees = await Promise.all(
      nodeIds.slice(0, 50).map(nodeId =>  // 최대 50개 제한
        client.send('DOM.describeNode', { nodeId, depth: 5 })
      )
    );

    return {
      type: 'selector_results',
      selector: selectorAll,
      count: nodeIds.length,
      elements: subtrees.map(({ node }) => normalizeNode(node)),
    };
  }

  if (selector) {
    // 단일 요소: DOM.querySelector
    const { nodeId } = await client.send('DOM.querySelector', {
      nodeId: await getRootNodeId(client),
      selector,
    });

    if (!nodeId) {
      return { type: 'not_found', selector };
    }

    const { node } = await client.send('DOM.describeNode', {
      nodeId,
      depth: input.depth ?? 8,
    });

    return {
      type: 'selector_result',
      selector,
      element: normalizeNode(node),
    };
  }
}
```

#### 기대 효과

- 응답 크기: 50KB → 1-5KB (선택자 기반 추출 시 90%+ 감소)
- LLM 토큰 처리량: 대폭 절감
- 응답 파싱 시간 단축 → 에이전트 루프 가속
- **예상 개선**: 추출 워크플로우에서 에이전트 턴당 처리 시간 30-50% 단축

#### 우선순위

**P2 (Medium)** — 에이전트 기반 워크플로우에서 토큰 효율성 향상

#### 구현 난이도

**Medium** — CDP DOM API 추가 활용, 기존 AX 트리 로직과 병행 구현.

#### 영향 범위

에이전트가 `read_page`를 반복 호출하는 모든 워크플로우. 특히 특정 데이터 필드만 필요한 구조화된 추출 시나리오.

---

### 2.7 [P2] 워크플로우 결과 스트리밍 — 부분 수집 지원

#### 문제 정의

`workflow_collect`는 모든 워커가 완료될 때까지 대기한 후 결과를 일괄 반환한다. 19개 워커가 완료되어도 1개의 느린 워커 때문에 결과 처리를 시작할 수 없다. 이로 인해 Phase 4가 이상 워커의 실행 시간에 종속된다.

#### 근본 원인

`src/tools/orchestration.ts`의 `workflow_collect` 핸들러는 모든 워커 상태가 완료(`COMPLETED` 또는 `ERROR`)로 전환될 때까지 폴링 루프를 실행한다. 완료된 워커의 결과를 즉시 반환하는 경로가 없다.

#### 개선 방안

`workflow_collect_partial` 도구를 신설한다. 현재 완료된 워커의 결과를 즉시 반환하고, 실행 중인 워커에 대해서는 상태만 보고한다. 선택적으로 `waitTimeoutMs`를 지정하여 남은 워커를 일정 시간 더 기다릴 수 있다.

#### 구현 상세

**신규 파일 섹션**: `src/tools/orchestration.ts` (핸들러 추가)

```typescript
interface WorkflowCollectPartialInput {
  workflowId: string;
  waitTimeoutMs?: number;      // 미완료 워커 대기 시간, 기본 0 (즉시 반환)
  includePartial?: boolean;    // 부분 데이터도 포함할지 여부
}

interface WorkflowCollectPartialOutput {
  workflowId: string;
  completed: WorkerResult[];
  running: Array<{ workerId: string; startedAt: number; lastUpdateAt: number }>;
  failed: WorkerResult[];
  summary: {
    total: number;
    completed: number;
    running: number;
    failed: number;
    isFullyComplete: boolean;
  };
}

async function handleWorkflowCollectPartial(
  input: WorkflowCollectPartialInput
): Promise<WorkflowCollectPartialOutput> {
  const { workflowId, waitTimeoutMs = 0, includePartial = false } = input;

  if (waitTimeoutMs > 0) {
    // 최대 waitTimeoutMs 동안 완료 대기 (폴링 간격 500ms)
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      const state = workflowEngine.getState(workflowId);
      if (state.running.length === 0) break;
      await sleep(500);
    }
  }

  const state = workflowEngine.getState(workflowId);

  return {
    workflowId,
    completed: state.completed.map(w => ({
      workerId: w.workerId,
      data: w.extractedData,
      status: 'COMPLETED',
      durationMs: w.completedAt - w.startedAt,
    })),
    running: state.running.map(w => ({
      workerId: w.workerId,
      startedAt: w.startedAt,
      lastUpdateAt: w.lastUpdateAt,
    })),
    failed: state.failed.map(w => ({
      workerId: w.workerId,
      error: w.error,
      status: 'ERROR',
    })),
    summary: {
      total: state.completed.length + state.running.length + state.failed.length,
      completed: state.completed.length,
      running: state.running.length,
      failed: state.failed.length,
      isFullyComplete: state.running.length === 0,
    },
  };
}
```

#### 기대 효과

- 첫 결과 도달 시간(TTFR): 마지막 워커 완료 대기 → 첫 워커 완료 즉시
- 20개 워커 중 19개 완료 후 즉시 처리 시작 가능
- 병렬 파이프라인 구성 가능: 완료 워커 결과를 다음 단계로 즉시 전달
- **예상 개선**: Phase 4 실효 지연 90%+ 단축 (이상 워커 격리 시)

#### 우선순위

**P2 (Medium)** — 결과 파이프라인 최적화

#### 구현 난이도

**Low** — 기존 인메모리 상태 조회 로직 래핑. 새 상태 관리 불필요.

#### 영향 범위

다단계 처리 파이프라인을 사용하는 워크플로우. 결과를 즉시 처리할 수 있는 배치 분석 시나리오.

---

### 2.8 [P2] 일괄 탭 내비게이션 — 병렬 페이지 로딩

#### 문제 정의

`workflow_init`에서 탭 내비게이션(URL 로딩)이 부분적으로 병렬화되어 있으나 최적화 여지가 있다. 20개 탭을 동시에 내비게이션하면 네트워크 대역폭 경합과 DNS 과부하가 발생할 수 있어 제어된 병렬화가 필요하다.

#### 근본 원인

`src/tools/orchestration.ts`의 탭 내비게이션이 `Promise.all`로 모든 탭을 동시에 실행하거나 완전 직렬로 실행되는 극단적인 구조일 경우 양쪽 모두 비최적이다. 동시성 제한자(concurrency limiter)를 적용한 배치 처리가 최적값을 제공한다.

#### 개선 방안

p-limit 기반 동시성 제어로 탭 내비게이션을 배치 처리한다. 경험적 최적값인 동시성 10으로 2개 배치(20/10)로 내비게이션을 완료한다.

#### 구현 상세

**수정 파일**: `src/tools/orchestration.ts`

```typescript
import pLimit from 'p-limit';

async function navigateWorkersInParallel(
  workers: Array<{ tabId: string; url: string }>,
  concurrency = 10
): Promise<NavigationResult[]> {
  const limiter = pLimit(concurrency);
  const navigationStart = Date.now();

  const results = await Promise.all(
    workers.map(worker =>
      limiter(async () => {
        const page = await sessionManager.getPageForTab(worker.tabId);
        const navStart = Date.now();

        await page.goto(worker.url, {
          waitUntil: 'domcontentloaded',  // 'networkidle' 대신 사용 (더 빠름)
          timeout: 30_000,
        });

        return {
          tabId: worker.tabId,
          url: worker.url,
          durationMs: Date.now() - navStart,
          success: true,
        };
      })
    )
  );

  console.debug(`[NavigateBatch] ${workers.length} tabs navigated in ${Date.now() - navigationStart}ms`);
  return results;
}
```

**추가 최적화**: `waitUntil: 'domcontentloaded'` 사용

현재 `networkidle`을 사용하는 경우, `domcontentloaded`로 변경하면 페이지의 모든 네트워크 요청이 완료될 때까지 기다리지 않아도 된다. 초기 DOM 로딩 후 JavaScript 실행으로 추가 데이터를 로드할 수 있다.

#### 기대 효과

- 내비게이션 배치 처리: 단계별 10개 병렬 (2배치 × ~3초 = 6초)
- Phase 1 기여 감소: 내비게이션 부분 ~40% 단축
- DNS/네트워크 경합 최소화로 개별 페이지 로딩 성공률 향상
- **예상 개선**: Phase 1에서 5-10초 단축

#### 우선순위

**P2 (Medium)** — Phase 1 최적화 항목

#### 구현 난이도

**Low** — 기존 코드에 p-limit 추가 및 concurrency 파라미터 주입.

#### 영향 범위

다수의 다른 도메인을 로딩하는 모든 워크플로우.

---

## 3. 구현 로드맵 (Implementation Roadmap)

### Phase A: P0 항목 (1주차) — 최대 임팩트 우선

**목표**: 에이전트 스폰 오버헤드 완전 제거 + 스크롤 타임아웃 제거

| 작업 | 파일 | 예상 공수 | 담당 |
|------|------|-----------|------|
| `batch_execute` 도구 구현 | `src/tools/batch-execute.ts` (신규) | 1일 | |
| SessionManager `getPageForTab()` 추가 | `src/session-manager.ts` | 0.5일 | |
| MCP 도구 등록 | `src/tools/index.ts` | 0.5일 | |
| `lightweight_scroll` 도구 구현 | `src/tools/lightweight-scroll.ts` (신규) | 0.5일 | |
| `computer.ts` skipScreenshot 옵션 추가 | `src/tools/computer.ts` | 0.5일 | |
| 통합 테스트 | — | 2일 | |

**Phase A 완료 후 예상 성능**: 375초 → ~87초 (77% 단축)

### Phase B: P1 항목 (2주차) — 안정성 및 처리량 개선

**목표**: 런어웨이 워커 방지 + 스크린샷 병렬화 + 커넥션 풀 최적화

| 작업 | 파일 | 예상 공수 | 담당 |
|------|------|-----------|------|
| `ScreenshotScheduler` 구현 | `src/cdp/screenshot-scheduler.ts` (신규) | 1일 | |
| computer.ts 스케줄러 통합 | `src/tools/computer.ts` | 0.5일 | |
| 워커 타임아웃 로직 구현 | `src/orchestration/workflow-engine.ts` | 1.5일 | |
| 서킷 브레이커 구현 | `src/orchestration/workflow-engine.ts` | 1일 | |
| `preWarmForWorkflow()` 구현 | `src/cdp/connection-pool.ts` | 1일 | |
| orchestration.ts 사전 워밍 통합 | `src/tools/orchestration.ts` | 0.5일 | |
| 통합 테스트 | — | 1.5일 | |

**Phase B 완료 후 예상 성능**: ~87초 → ~55초 (추가 37% 단축)

### Phase C: P2 항목 (3주차) — 사용성 및 효율성 향상

**목표**: 선택자 기반 추출 + 스트리밍 수집 + 내비게이션 최적화

| 작업 | 파일 | 예상 공수 | 담당 |
|------|------|-----------|------|
| `read_page` selector 파라미터 추가 | `src/tools/read-page.ts` | 1.5일 | |
| `workflow_collect_partial` 구현 | `src/tools/orchestration.ts` | 1일 | |
| 배치 탭 내비게이션 최적화 | `src/tools/orchestration.ts` | 0.5일 | |
| waitUntil 설정 최적화 | `src/tools/orchestration.ts` | 0.5일 | |
| 문서 업데이트 | — | 1일 | |
| 종합 성능 테스트 | — | 1.5일 | |

**Phase C 완료 후 예상 성능**: ~55초 → ~50초 (추가 10% 단축)

---

## 4. 기대 효과 종합 (Expected Results Summary)

### 4.1 단계별 개선 비교표

| 단계 | 현재 | Phase A 후 | Phase B 후 | Phase C 후 |
|------|------|-----------|-----------|-----------|
| Phase 1: workflow_init | 37.2초 | 37.2초 | 22초 | 15초 |
| Phase 2: 에이전트 스폰 | 109.0초 | **0초** | 0초 | 0초 |
| Phase 3: 병렬 실행 | 214.3초 | **50초** | 30초 | 25초 |
| Phase 4: workflow_collect | 15.1초 | 15.1초 | 15초 | 5초 |
| **합계** | **375.6초** | **~102초** | **~67초** | **~45초** |
| **개선율** | 기준 | **73%** | **82%** | **88%** |

### 4.2 시나리오별 개선 효과

| 시나리오 | 현재 | 개선 후 | 개선율 |
|----------|------|---------|--------|
| 20개 프로필 크롤링 (정상) | 375.6초 | ~45초 | 88% |
| 20개 프로필 크롤링 (이상 1개) | 455+초 | ~75초 | 84% |
| 50개 프로필 크롤링 (예상) | ~900초+ | ~110초 | 88% |
| 단순 데이터 추출 (10개) | ~180초 | ~15초 | 92% |

### 4.3 워커 수 확장성 비교

| 워커 수 | 현재 에이전트 스폰 비용 | batch_execute 후 |
|---------|----------------------|-----------------|
| 10개 | ~55초 | ~0초 |
| 20개 | ~109초 | ~0초 |
| 50개 | ~275초 | ~0초 |
| 100개 | ~550초 | ~0초 |

`batch_execute` 도입 후 에이전트 스폰 비용은 워커 수와 무관하게 0에 수렴한다.

---

## 5. 리스크 평가 (Risk Assessment)

### 5.1 [P0] batch_execute

| 리스크 | 심각도 | 가능성 | 완화 전략 |
|--------|--------|--------|-----------|
| JavaScript 추출 스크립트 복잡도 증가 (LLM이 JS 코드 생성 필요) | 중 | 중 | 공통 추출 패턴 라이브러리 제공 (헬퍼 함수 모음) |
| 에이전트 기반 적응형 크롤링 불가 (JS 실행 결과에 따른 동적 분기) | 고 | 중 | 에이전트 모드와 배치 모드를 워크플로우 타입으로 구분 제공 |
| 페이지 로딩 완료 전 스크립트 실행 | 중 | 중 | `waitForSelector` 옵션 추가, 재시도 로직 내장 |
| 메모리 사용량 증가 (50개 탭 동시 활성) | 중 | 저 | 탭당 메모리 모니터링, maxWorkersPerSession 재조정 |

### 5.2 [P0] lightweight_scroll

| 리스크 | 심각도 | 가능성 | 완화 전략 |
|--------|--------|--------|-----------|
| JS scroll이 일부 SPA에서 동작 안 함 (이벤트 리스너 무시) | 중 | 저 | CDP Input.dispatchMouseEvent 폴백 구현 |
| 스크롤 위치 확인 불가 (스크린샷 없음) | 저 | 중 | scrollY/scrollX 반환값으로 위치 확인 |
| 무한 스크롤 트리거 실패 | 중 | 저 | `dispatchEvent(new Event('scroll'))` 병행 실행 옵션 추가 |

### 5.3 [P1] ScreenshotScheduler

| 리스크 | 심각도 | 가능성 | 완화 전략 |
|--------|--------|--------|-----------|
| 동시성 값 부적절 설정 시 오히려 느려질 수 있음 | 중 | 중 | `SCREENSHOT_CONCURRENCY` 환경변수로 튜닝 가능, 기본값 5 |
| 큐 백프레셔 부재 시 메모리 과부하 | 중 | 저 | 최대 큐 크기(예: 100) 제한 추가 |
| 타임아웃 처리 복잡성 증가 | 저 | 중 | 요청당 개별 타임아웃 유지 |

### 5.4 [P1] 워커 타임아웃 & 서킷 브레이커

| 리스크 | 심각도 | 가능성 | 완화 전략 |
|--------|--------|--------|-----------|
| 정당한 작업이 타임아웃으로 중단될 수 있음 | 고 | 중 | 기본 타임아웃을 충분히 길게 설정(60s), 워크플로우별 오버라이드 가능 |
| 서킷 브레이커 오탐 (느린 페이지 = 스테일로 판단) | 중 | 중 | 스테일 판단 기준을 데이터 해시 변화로 제한 (반복 호출 횟수 아닌) |
| 부분 완료 데이터의 일관성 보장 어려움 | 중 | 저 | 부분 완료 표시와 완전 완료 구분, 소비 측에서 필터링 |

### 5.5 [P1] 적응형 커넥션 풀

| 리스크 | 심각도 | 가능성 | 완화 전략 |
|--------|--------|--------|-----------|
| maxPoolSize(25) 초과 시 예외 발생 | 중 | 고 | 사전 워밍 요청을 min(needed, maxPoolSize-current)로 제한 |
| 사전 워밍 페이지가 TTL 전에 만료 | 저 | 중 | 페이지 생성 시간 기록, 워커 배정 전 유효성 확인 |
| Chrome 메모리 압박 | 중 | 중 | 미사용 사전 워밍 페이지 5분 후 자동 반환 |

### 5.6 [P2] 선택자 기반 read_page

| 리스크 | 심각도 | 가능성 | 완화 전략 |
|--------|--------|--------|-----------|
| 선택자 변경에 취약한 크롤링 코드 | 중 | 고 | 선택자 실패 시 전체 트리 폴백 옵션 제공 |
| CDP DOM API 지원 여부 Chrome 버전 의존 | 저 | 저 | 최소 Chrome 버전 요구사항 문서화 |

### 5.7 [P2] 결과 스트리밍

| 리스크 | 심각도 | 가능성 | 완화 전략 |
|--------|--------|--------|-----------|
| 부분 결과와 최종 결과 중복 처리 | 중 | 중 | `isFullyComplete` 플래그로 소비 측에서 중복 방지 |
| 경쟁 조건 (수집 중 워커 완료) | 중 | 저 | 인메모리 상태 읽기에 뮤텍스 적용 (기존 promise-mutex 활용) |

---

## 부록: 빠른 참조

### 개선 항목 우선순위 요약

| 항목 | 우선순위 | 난이도 | 예상 시간 단축 |
|------|---------|--------|--------------|
| batch_execute 도구 | P0 | Medium | -109초 (Phase 2 제거) |
| lightweight_scroll | P0 | Low | -180초 (이상 워커 제거) |
| ScreenshotScheduler | P1 | Low | 처리량 3-5배 |
| 워커 타임아웃/서킷 브레이커 | P1 | Medium | 최악 케이스 60초 이하 |
| 적응형 커넥션 풀 | P1 | Medium | -15초 (Phase 1) |
| 선택자 기반 read_page | P2 | Medium | 토큰 90% 절감 |
| 결과 스트리밍 | P2 | Low | TTFR 대폭 단축 |
| 배치 탭 내비게이션 | P2 | Low | -5-10초 (Phase 1) |

### 핵심 파일 경로 참조

| 파일 | 역할 |
|------|------|
| `src/tools/orchestration.ts` | workflow_init, workflow_collect 핸들러 |
| `src/orchestration/workflow-engine.ts` | 워크플로우 상태 관리 |
| `src/tools/computer.ts` | 스크린샷, 스크롤, 클릭 |
| `src/tools/read-page.ts` | 접근성 트리 추출 |
| `src/session-manager.ts` | 워커/탭 생성 및 관리 |
| `src/cdp/connection-pool.ts` | 페이지 풀 관리 |
| `src/cdp/client.ts` | CDP 연결, 쿠키 캐싱 |
| `src/tools/worker-create.ts` | 워커 생성 도구 |

---

*이 문서는 2026-02-21 기준으로 작성되었으며, 실험 결과 및 구현 진행에 따라 업데이트될 수 있다.*
