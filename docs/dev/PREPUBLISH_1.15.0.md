# 1.15.0 게시 전 검증

확인일: 2026-09-23. npm publish 직전까지의 검증 기록이다. npm publish와 정식 GitHub release 공개는 실행하지 않았다.
후보 커밋: `release/1.15.0-prepublish`의 `1c79070c`(이 문서를 추가하는 커밋 직전). 문서만 바뀌므로 패키지 내용은 같다.

## 패키지

| 항목 | 값 |
|---|---|
| 버전 | 1.15.0 (package.json, package-lock.json) |
| tarball | `openchrome-mcp-1.15.0.tgz`, 2,504,488 bytes, 2,524 entries |
| sha256 | `a68d0b7f23951947b909ff567452b6b92e48dfa498c0574f718e2048893966ff` |
| integrity | `sha512-FLpKPrOiioA5XnxytgJYP1Llkg70OxsbP4zyfIVm+lJz7+kGdqolqudZaNXHA65AXK8nWRGKto1rJFultfCaEA==` |
| 새 런타임 의존성 | `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/node` 2.0.0 (zod 4, hono 경유) |
| Node.js 하한 | 20 (`engines.node >=20.0.0`, doctor 검사 동기화) |

`npm publish --dry-run`은 통과했고 integrity가 위 값과 일치한다. dry-run의
`"bin[...]" script name dist/cli/index.js was invalid and removed` 경고는 npm 11이 `./dist/cli/index.js`를
`dist/cli/index.js`로 정규화하면서 내는 문구다. 1.14.0에서도 같으며 bin은 유지된다(registry의 1.12.9도 두 bin 보유,
설치 시 `openchrome`·`oc` 링크 생성 확인). registry 인증이 없어 dry-run만 실행했다.

## 로컬 검증 (Windows 11, Node 24.18, Chrome 153)

| 검증 | 결과 |
|---|---|
| build, lint, lint:tier, lint:repo-structure, lint:tool-schemas(신규 0), capability map | 통과 |
| checkout 외부 설치, CLI `--version` | 1.15.0 |
| 설치본 legacy 수락(`harness:frontier --runtime-contract --confirmed-scope`, 실제 headless Chrome) | 통과. lazy startup, 탭 용량 거부, 사람 제어·재개, 취소 결과 불명, drain 확인 |
| 설치본 modern 수락(`harness:modern-installed`, SDK v2 클라이언트 2026-07-28 고정, 실제 headless Chrome) | 통과. modern 협상, runtime 계약, workspace 요구, 브라우저 왕복, 닫힌 handle 거부 |
| 공식 conformance(`@modelcontextprotocol/conformance` 0.1.16) | server-initialize, ping, tools-list, resources-list, logging-set-level 각 1/1, dns-rebinding-protection 2/2 |
| 전체 Jest(스택 상단) | 586+ suites 통과. Windows 전용으로 main에서도 실패하는 2개(twofa-handler, e2e harness 경로)와 부하 민감 테스트(단독 재실행 통과) 제외 |

conformance 0.1.16에는 2026-07-28 시나리오가 없고, 도구·프롬프트 시나리오는 공식 참조 서버의 고정 도구를 전제로 한다.
modern 규약은 공식 SDK v2 클라이언트로 실제 코어를 구동하는 테스트로 검증한다.

## CI (GitHub Actions, 현재 head 기준)

stacked PR은 main 대상이 아니어서 자동 트리거되지 않으므로 `workflow_dispatch`로 실행했다. CI는 full Jest 포함이다.

| 브랜치(PR) | head | CI | 설치본 수락(ubuntu+windows) |
|---|---|---|---|
| fix/legacy-http-isolation (#1674) | 0db4c442 | [35767744700](https://github.com/shaun0927/openchrome/actions/runs/35767744700) 통과 | [35767744728](https://github.com/shaun0927/openchrome/actions/runs/35767744728) 통과 |
| feat/mcp-2026-07-28 (#1675) | 072ae099 | [35778548739](https://github.com/shaun0927/openchrome/actions/runs/35778548739) 통과 | [35778552206](https://github.com/shaun0927/openchrome/actions/runs/35778552206) 통과 |
| feat/mcp-workspace-handles (#1676) | c580ad5d | [35778555889](https://github.com/shaun0927/openchrome/actions/runs/35778555889) 통과 | [35778559277](https://github.com/shaun0927/openchrome/actions/runs/35778559277) 통과 |
| feat/mcp-mrtr-request-state (#1677) | a88187df | [35778562654](https://github.com/shaun0927/openchrome/actions/runs/35778562654) 통과 | [35778566669](https://github.com/shaun0927/openchrome/actions/runs/35778566669) 통과 |
| feat/runtime-drain-contract (#1678) | d8ebf4e8 | [35781274096](https://github.com/shaun0927/openchrome/actions/runs/35781274096) 통과 | [35781278734](https://github.com/shaun0927/openchrome/actions/runs/35781278734) 통과 |
| release/1.15.0-prepublish (#1679) | 7c256bba | [35784361708](https://github.com/shaun0927/openchrome/actions/runs/35784361708) 통과(build-and-test, full-test, mcp-conformance) | [35785288066](https://github.com/shaun0927/openchrome/actions/runs/35785288066) 통과(legacy·modern 설치본 단계 모두) |

릴리스 브랜치의 mcp-conformance job은 처음에 Node 20에서 실패했다(conformance CLI가 Node 22 API 사용). job을 Node 22로 옮겼다.
같은 단계에서 full-test의 `tabs-activate` 타이밍 테스트 1건이 한 번 실패했고, 재실행과 로컬 3회에서 통과했다(해당 도구는 이 스택에서 변경하지 않음).

설치본 수락은 이식 직후 한 번 실패했다. SDK stdio가 취소된 요청에 응답하지 않는데(MCP 규약), harness가 응답을 60초 기다렸기 때문이다.
harness가 규약상 무응답을 허용하도록 고쳤고 동작 변경은 문서화했다.

## 독립 검토

각 PR은 별도 검토 에이전트(읽기 전용 checkout)가 검토했고, 지적은 모두 반영 후 재검토에서 승인됐다.

| PR | 1차 판정 | 주요 지적 | 재검토 |
|---|---|---|---|
| #1674 | REQUEST_CHANGES | 공개 embedded API의 both 모드 미전환, listener 누수 | APPROVE |
| #1675 | APPROVE + silent-failure P1 3건 | 재시도 경로의 input_required 삼킴, broker 스트림 포기, rate limit 순서 | 반영(회귀 테스트 증명) |
| #1676 | REQUEST_CHANGES | 세션 범위 도구의 workspace 노출, 사람 제어 중 만료, close scope | APPROVE |
| #1677 | REQUEST_CHANGES | 질문 내용 바인딩, JWT 주체 바인딩, resources/read catch | APPROVE |
| #1678 | REQUEST_CHANGES | 백그라운드 작업 drain 누락, 종료 순서, SIGHUP 예산, 게이트 취소 | APPROVE |

## #1673 종료 기준

| 기준 | 상태 | 증거 |
|---|---|---|
| modern 지원 범위와 legacy 정책의 구현·문서 일치 | 충족 | docs/mcp-2026-07-28.md, `src/mcp/protocol-matrix.ts`와 문서 동기화 테스트, runtime 계약 테스트 |
| 같은 연결의 교차·동시 요청 간 정보·권한 누출 없음 | 충족 | workspace 통합 테스트(12개 동시 요청, tenant·workspace·capability 교차), client-message-routing |
| 새 연결에서 같은 handle 사용, 무효·타 tenant handle은 브라우저 동작 전 거부 | 충족 | workspace 통합 테스트(`getOrCreateSession` 호출 0회 단언) |
| 요청별 version·capability 검증이 initialize 캐시에 의존하지 않음 | 충족 | SDK envelope, modern·legacy 동일 endpoint 통합 테스트, capability 교차 테스트 |
| MRTR 재개·만료·취소·중복 입력, 구독 종료 후 무전송 | 충족 | mrtr-request-state(변조·만료·재사용·인자 변경·질문 변경·타 tenant·다중 라운드), 구독 종료 테스트 |
| HTTP metadata 불일치와 modern/legacy 혼용 오류 | 충족 | http-modern-mcp(Mcp-Name 불일치), http-streamable(분류 전 거부, legacy 버전 거부) |
| 프로세스 교체 후 오래된 참조 거부, 결과 불명 mutation 재실행 없음 | 충족 | runtime-drain(이전 handle·runtimeId 거부, 부작용 0회, execution unknown) |
| 사용자 탭 보존, background 정책, tenant 권한, learning 비활성 기본값 회귀 없음 | 충족 | full Jest CI, 설치본 수락 |
| 독립 클라이언트 conformance, Jest, 빌드, lint, Windows/Linux 설치 수락 | 충족 | SDK v2 클라이언트 테스트, 공식 conformance, 위 CI |
| 최종 커밋의 독립 검토와 실제 browser QA 증거 | 충족(스택 PR 단위) | 위 검토 표, 설치본 legacy·modern 수락 |
| 광고·release note가 검증 범위와 일치한 뒤 이슈 종료 | 병합 대기 | RELEASE_NOTES_1.15.0.md. 스택 병합 후 관리자가 종료 |

## 남은 게시 게이트

1. 스택 PR을 #1674부터 순서대로 main에 병합한다(각 PR base가 앞 PR 브랜치다).
2. main 병합 커밋으로 패키지를 다시 만들고 설치본 수락(legacy·modern)을 반복한다.
3. GitHub release 초안의 대상을 main 병합 SHA로 맞추고 tarball 해시를 갱신한다.
4. npm 인증 후 `npm publish`와 release 공개를 별도 요청으로 실행한다. 1.13.0·1.14.0은 건너뛰고 1.15.0을 latest로 게시한다.
