<p align="center">
  <img src="assets/mascot.png?v=4" alt="OpenChrome Raptor" width="180">
</p>

<h1 align="center">OpenChrome</h1>

<p align="center">
  <b>하니스 엔지니어링 기반 브라우저 자동화</b><br>
  실제 Chrome을 구동하고, AI 에이전트를 안내하는 MCP 서버.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openchrome-mcp"><img src="https://img.shields.io/npm/v/openchrome-mcp" alt="npm"></a>
  <a href="https://github.com/shaun0927/openchrome/releases/latest"><img src="https://img.shields.io/github/v/release/shaun0927/openchrome" alt="Latest Release"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>한국어</b>
</p>

---

## 무엇인가

OpenChrome은 **MCP 서버**입니다. Chrome DevTools Protocol을 통해 이미 로그인된
실제 Chrome을 직접 제어합니다 — 중간 계층도, 별도 브라우저도, 재인증도 없습니다.
Chrome 프로세스 하나에 격리된 탭 여러 개, 20개 병렬 레인이 ~300MB.

핵심은 **하니스 엔지니어링**입니다. 단순히 브라우저 API를 노출하는 게 아니라,
힌트 엔진·서킷 브레이커·자동 복구 런타임·토큰 효율적 페이지 직렬화로 API를
감쌉니다. 그래서 에이전트는 실수를 덜 하고, "고민" 없이 복구하며, 토큰을 훨씬
적게 씁니다.

```
사용자: Amazon, eBay, Walmart, Best Buy에서 "AirPods Pro" 가격 비교해줘

AI:    [4개 병렬 레인, 모든 사이트 이미 인증됨]
       Best Buy $179 · Amazon $189 · Walmart $185 · eBay $172
       2.4초 — 실시간 페이지, 봇 탐지 우회
```

| | 기존 방식 (Playwright 등) | OpenChrome |
|---|:---:|:---:|
| 5개 사이트 작업 | ~250초 (매번 로그인) | **~3초** (병렬) |
| 메모리 | ~2.5GB (브라우저 5개) | **~300MB** (Chrome 1개) |
| 재인증 | 매 실행마다 | **불필요** |
| 봇 탐지 | 차단됨 | **투명** (실제 Chrome) |

---

## 빠른 시작

설치하고 MCP 클라이언트를 연결 — 명령어 하나면 됩니다:

```bash
npm install -g openchrome-mcp

openchrome setup                       # Claude Code
openchrome setup --client codex        # Codex CLI
npx openchrome-mcp setup --client opencode   # OpenCode
```

MCP 클라이언트를 재시작하세요. 끝입니다 — 첫 도구 호출 시 Chrome이 자동 실행됩니다.

<details>
<summary>수동 MCP 설정 (Cursor / VS Code / Windsurf 등)</summary>

```json
{
  "mcpServers": {
    "openchrome": {
      "command": "openchrome",
      "args": ["serve", "--auto-launch"]
    }
  }
}
```

나중에 `openchrome update`로 CLI와 클라이언트 설정을 갱신할 수 있습니다.
</details>

**터미널이 부담스럽다면?** 원클릭 [데스크톱 앱](https://github.com/shaun0927/openchrome/releases?q=desktop)
(macOS / Windows / Linux, 베타)이 Node.js 설정 없이 서버를 실행합니다.

---

## 무엇을 할 수 있나

평범한 언어로 에이전트에게 요청하면 OpenChrome 도구로 매핑됩니다:

- **병렬 리서치** — "AWS 결제, GCP, Stripe, Datadog 스크린샷 한 번에" → 4개 레인, Chrome 하나, 모두 인증된 상태.
- **인증된 스크래핑** — 기존 로그인을 그대로 써서 대시보드·회원 전용 페이지를 크롤링. 설정 파일에 자격증명 불필요.
- **폼 & 플로우 자동화** — 멀티스텝 플로우의 입력·클릭·이동을 처리하고, 스텝이 어긋나면 에이전트가 교정 힌트를 받습니다.
- **프로덕션 UI 디버깅** — `oc_performance_insights` / `oc_vitals`로 LCP/CLS, `console_capture`, `oc_devtools_url`로 라이브 DevTools 연결.
- **사이트 모니터링 & 비교** — `oc_evidence_bundle` 스냅샷 + `oc_diff`로 결정론적 before/after 비교 (DOM, 스크린샷 pHash, 네트워크, 콘솔).
- **크롤링** — 비동기 `crawl_start` / `crawl_status` / `crawl_cancel` 잡, 커서 페이지네이션 지원.
- **검증 가능한 실행** — `oc_assert`가 페이지 상태를 Outcome Contract로 검증 (pass / fail / inconclusive) — 추측 대신 계약.

기본 도구 표면은 내비게이션·상호작용·읽기·추출·병렬 워크플로·계약·스킬·복구·진단에
걸쳐 약 110개입니다. 전체 목록: [`docs/agent/capability-map.md`](docs/agent/capability-map.md).

---

## 편하게 쓰는 법

### MCP 호스트 없이 셸에서 구동

CLI가 MCP 표면을 직접 호출할 수 있습니다. 스크립트·CI·디버깅에 유용:

```bash
oc run navigate --arg url=https://example.com
oc run read_page --arg mode=dom --json
oc navigate https://example.com      # 자주 쓰는 도구는 위치 인자 단축형
oc click ref_5
```

### `oc playbook`으로 선언적 시나리오

각 스텝이 도구 호출 하나 + 인라인 Outcome Contract인 YAML 시나리오를 작성 —
결정론적이며 LLM 판단이 없습니다:

```bash
oc playbook run scenario.yaml --vars url=https://iana.org --out report.md
```

자세히: [`docs/cli/playbook.md`](docs/cli/playbook.md).

### 브라우저 하나를 계속 띄워두기 — HTTP 데몬 모드

OpenChrome을 장기 실행 데몬으로 띄우면 여러 클라이언트(Claude Code + CI +
대시보드)가 Chrome 프로세스 **하나**를 공유하고, 서버는 자신을 띄운 주체보다
오래 생존합니다 (Docker, systemd, CI):

```bash
openchrome serve --http 3100 --auth-token <토큰> --idle-timeout 30m
curl -s http://127.0.0.1:3100/health
```

Chrome 프로세스 하나, 탭은 세션별 격리. `--idle-timeout` 없이는 중지할 때까지
유지되고, 설정하면 유휴 시간 후 스스로 종료합니다. 전체 가이드:
[`docs/getting-started/http-daemon.md`](docs/getting-started/http-daemon.md).

### 환경 진단

```bash
openchrome doctor      # Node, 디스크, Chrome 바이너리/포트, 고아 프로세스, 권한, 락
openchrome check       # CLI + 런타임 연결 확인
```

### 토큰 효율적인 페이지 읽기

`read_page mode="dom"`은 페이지를 압축된 텍스트 형태로 직렬화합니다 — 원본 DOM
대비 **토큰 ~5–15배 절감**. 각 요소에 affordance 마커가 붙어 에이전트가 한눈에
종류를 파악합니다:

```
# [142]<input type="search" .../> ★      ← # 텍스트 입력
$ [156]<button type="submit"/>Search ★   ← $ 버튼 / 컨트롤
@ [289]<a href="/home"/>Home ★           ← @ 링크   (% = 시각 요소)
```

`[backendNodeId]` 식별자는 노드 수명 동안 안정적입니다 — `142`, `node_142`, `ref_N`
중 무엇이든 액션 도구에 넘기면 됩니다. `oc_observe`는 한 발 더 나아가, `read_page →
query_dom → inspect → interact` 대신 **바로 실행 가능한 번호 목록을 한 번에** 반환합니다.

---

## 왜 에이전트가 덜 실패하나

브라우저 자동화의 병목은 스텝 사이 LLM의 *추론*입니다 — 잘못된 추측 하나가
10–15초의 추론 비용입니다. OpenChrome의 하니스가 이 루프를 끊습니다:

| 서브시스템 | 하는 일 |
|---|---|
| **힌트 엔진** (30+ 규칙) | 에러→복구 패턴을 포착해 실수가 번지기 전에 교정. 반복되는 패턴은 영구 규칙으로 승격. |
| **복구 런타임** | 도구 호출에 대한 결정론적·유한 복구 — LLM 왕복 없이 서버 안에서 복구 (pilot 티어). |
| **Ralph 엔진** | 7단계 상호작용 워터폴: AX 클릭 → CSS → CDP 좌표 → JS → 키보드 → raw 마우스 → 사람 에스컬레이션. |
| **3단계 서킷 브레이커** | 요소 / 페이지 / 전역 — 영구적으로 깨진 요소에 토큰을 태우지 않게 차단. |
| **결과 분류기** | 클릭 후 실제로 무슨 일이 일어났는지 보고 (SUCCESS / SILENT_CLICK / WRONG_ELEMENT). |
| **49개 신뢰성 메커니즘** | 프로세스 수명부터 MCP 게이트웨이까지 8개 방어 계층 — 단일 실패로 서버가 멈추지 않음. [`docs/architecture.md`](docs/architecture.md) 참고. |

일반적인 5개 사이트 작업 기준: LLM 호출 ~80% 감소, 실제 소요 시간 ~80배 단축,
비용 ~5배 절감.

---

## 알아두면 좋은 그 외 기능

- **병렬 세션** — Chrome 1개, 탭/레인 N개; `workerId` + `profileDirectory`로 클라이언트별 격리. 여러 MCP 클라이언트가 안전하게 탭을 공유.
- **봇 차단 / Turnstile 대응** — 3단계 자동 폴백 (headless → stealth → 실제 headed Chrome)으로 CDN/WAF 차단 우회. [Turnstile 가이드](docs/turnstile-guide.md).
- **대화형 로그인** — 런처가 기본적으로 화면에 보이게 실행되므로 2FA/CAPTCHA를 한 번 완료한 뒤 영구 프로필을 재사용.
- **세션 지속성** — `--persist-storage`로 쿠키 + localStorage를 원자적으로 저장해 headless에서 재사용.
- **Shadow DOM** — CDP-pierced 읽기로 open + closed 루트 지원; `javascript_tool`에 `__pierce()` / `__openchrome.querySelectorAllDeep()` 헬퍼.
- **요소 인텔리전스** — 자연어로 요소 찾기 (AX 우선, CSS 폴백, 한국어 role 키워드 내장: `"버튼"` → button).
- **core / pilot 티어** — core는 기본 활성이며 안정적 표면을 보존; `--pilot`로 contract runtime, handoff persistence, voting, skill curator를 켤 수 있음.

---

## 서버 & headless 배포

```bash
openchrome serve --server-mode     # headless + 자동 실행 + 서버 기본값
```

로그인 없이 CI/CD와 컨테이너에서 동작합니다 — 내비게이션, 스크래핑, 스크린샷,
폼, 병렬 워크플로가 모두 클린 세션에서 실행됩니다. 프로덕션용 `Dockerfile` 포함
(`docker build -t openchrome . && docker run openchrome`).

인증 (테넌트별 API 키, JWT/OAuth, 공유 토큰): [`docs/auth.md`](docs/auth.md).
Transport 안정성 정책: [`docs/transport-lifecycle.md`](docs/transport-lifecycle.md).

---

## 문서

| 주제 | 링크 |
|---|---|
| 아키텍처 & 신뢰성 계층 | [`docs/architecture.md`](docs/architecture.md) |
| 시작하기 워크스루 | [`docs/getting-started.md`](docs/getting-started.md) |
| 전체 도구 카탈로그 | [`docs/agent/capability-map.md`](docs/agent/capability-map.md) |
| CLI & playbook | [`docs/cli.md`](docs/cli.md) · [`docs/cli/playbook.md`](docs/cli/playbook.md) |
| HTTP 데몬 모드 | [`docs/getting-started/http-daemon.md`](docs/getting-started/http-daemon.md) |
| 리서치 레시피 | [`docs/recipes/README.md`](docs/recipes/README.md) |
| 최신 릴리스 노트 | [`docs/releases/v1.12.0.md`](docs/releases/v1.12.0.md) |

---

## 개발

```bash
git clone https://github.com/shaun0927/openchrome.git
cd openchrome
npm install && npm run build && npm test
```

소스 변경 제출 전 린트: `npm run lint -- --max-warnings=0`
(변경 파일만 검사하려면 `npm run lint:changed -- --base origin/develop`).
PR은 `develop` 브랜치를 대상으로 합니다.

## 라이선스

MIT
</content>
