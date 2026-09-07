# OpenChrome 확정 작업 결과

확정한 7개 핵심 영역의 구현과 공통 검증을 진행했고, 실행 코드를 PR [#1664](https://github.com/shaun0927/openchrome/pull/1664)에 반영했다. 기능·설치·업그레이드 시험은 통과했다. 성능은 반복 간 편차가 커 일관된 속도 개선으로 판정하지 않는다. 병합과 npm 배포는 수행하지 않았다.

## 기준 버전과 결과물

- 실행 코드: `0ce93cb33e560c7d129c3c32ea5a4ef27cdbc3a8`.
- 확인한 최신 main: `afaf391f2db639474b8c3641254008b3fa4ad6f5` (2026-09-01).
- 공개 npm 최신: `1.12.9`, gitHead `25dd4f8a2eaa1545c14bae13e63fcd6675d41bea`. 후보의 버전 번호도 1.12.9이며 새 공개 릴리스가 아니다.
- 설치 후보 SHA-512: `sha512-CI/tJGtltdGA1VIvTUabgaop6owq0pgx9l/8VBU46t7dk3QCWkGZJWtx+lQvMQuwNEGX4w8XUGCljJ5qY3o0yg==`.
- 설치 파일과 빌드 결과 2,383개를 비교해 불일치 0개를 확인했다.
- 사용법: [브라우저 관찰·사람 개입·재개](agent/browser-control.md).

## 확정 범위별 처리

| 영역 | 구현 및 검증 결과 |
|---|---|
| 브라우저 실행·창 방해 | 지연 시작 유지, 소유한 초기 빈 탭만 정리, 명시적 headless의 자동 headed 전환 차단. 도구 목록 조회 시 Chrome 미실행과 작업 종료 후 프로세스 종료 확인. |
| 로그인·계정 상태 | 컨텍스트별 저장 복원과 watchdog 분리. 새로운 쿠키·localStorage 보존. URL/표시 계정 조건 검사 제공. 만료는 명시적으로 재로그인하며 복원을 인증 성공으로 표시하지 않음. |
| 병렬 작업·자원 | 동일 탭 직렬화, 독립 탭 병렬 처리, 큐·탭·스크린샷·작업 수 제한. 한도 초과 시 진행 중 탭을 버리지 않고 실행 전 거절. 사람 조작 중인 탭은 TTL·메모리 압박 정리에서 보존. |
| 속도 | `tabs_context`의 탭 조회를 최대 5개씩 병렬화. 제어된 대기 시험으로 5개 동시 입장·상한·결과 순서 보존 확인. 실브라우저 비교는 아래와 같이 혼합 결과. |
| 취소·실패 | MCP 세션별 취소 알림, 전체 실행 및 복구의 마감, 실행 전/실행 여부 불명 구분. 불확실한 쓰기를 자동 반복하지 않음. 중첩 실행의 명령 추적을 분리해 대기 충돌 방지. |
| headless 관찰 | `oc_browser_control status`로 현재·최근 도구, 진행 중 쓰기, 조작권 상태 제공. 페이지 내용·화면은 기존 도구 사용. |
| 사람 개입 | pause → 진행 중 명령 종료 대기 → human → URL/계정 검증 후 명시적 resume. 오래된 요소 참조 폐기. 다른 탭 입력은 계속 가능하며 범위가 불명확한 쓰기는 보수적으로 차단. |

JavaScript 한 줄의 여러 문장에서 첫 표현식 뒤에 조기 반환하던 결함도 실제 취소 시험 중 발견해 수정했다.

## 검증 결과

- 관련 테스트 190개 통과: 17개 suite의 189개 및 추가 동시성 시험 1개. 전체 저장소 테스트 전부를 실행했다는 의미는 아니다.
- [일반 CI](https://github.com/shaun0927/openchrome/actions/runs/34128708454): 빌드, lint, 구조, 의존성 경계, 스키마, capability map, 변경 테스트, 소스 smoke, 패키지 검사 통과. 선택적 full-test는 생략됐다.
- [Windows/Linux 설치 CI](https://github.com/shaun0927/openchrome/actions/runs/34128708444): 두 플랫폼 모두 통과. PR 실행 코드 0ce93cb와 main을 합친 `27dbf6fadf51bd436458b7c92b26077992cf82f6`에서 검증했다.
- 로컬 Windows Chrome 152.0.7977.82, CI Linux Chrome 152.0.7977.64, CI Windows Chrome 151.0.7922.174에서 시험했다.
- 설치 패키지를 checkout 외부와 별도 cwd에서 실행했다. 4개 격리 계정, 서버가 기록한 25개 쓰기, 중복 0개, 세션 만료 거절과 명시적 재로그인을 확인했다.
- 잘못된 계정 조건 거절, pause 중 입력 차단, 독립 탭 실행, 잘못된 resume 후 pause 유지, 취소 응답 뒤에도 남은 CDP 작업 종료까지 조작권 대기를 확인했다.
- Windows foreground 이벤트 관찰에서 최종 설치·업그레이드 시험 모두 소유한 Chrome이 전경으로 전환한 이벤트 0개. 관찰은 MCP 시작 전부터 최종 Chrome 종료까지 수행했다.
- 업그레이드: 직전 후보 `47da230`에서 저장하고 종료한 뒤 최종 후보를 같은 임시 설치 경로에 재설치했다. 4개 컨텍스트 모두 로그인 엔드포인트를 다시 호출하지 않고 인증된 서버 probe에 성공했다. 이전 Chrome과 최종 Chrome 종료도 확인했다.
- 메모리 표본은 설치 시험에서 7개 수집했다. 프로세스 트리 working set 합계이며 공유 페이지를 중복 계산할 수 있다. 장시간 누수 부재나 메모리 절감률을 입증하는 시험은 아니다.

## 성능 비교

직전 후보 `47da230`과 개선 후보 `0ce93cb`를 같은 Windows 머신에서 번갈아 각각 3회 독립 실행했다. 각 실행은 4개 탭으로 warmup 1회 후 조회 10회를 측정했다. 단위는 ms이며 각 셀은 p50 / p95다.

| 독립 실행 | 직전 후보 | 개선 후보 |
|---|---:|---:|
| 1 | 11.95 / 15.08 | 6.23 / 8.26 |
| 2 | 11.95 / 17.74 | 16.38 / 43.51 |
| 3 | 10.02 / 11.22 | 5.83 / 6.49 |

실행별 p50의 중앙값은 11.95 → 6.23ms였지만 개선 후보 2회차는 더 느렸고, 가장 큰 p95도 17.74 → 43.51ms로 악화됐다. 모든 표본을 남겼으며 특정 느린 실행을 제거하지 않았다. **일관된 성능 향상, 전체 작업 시간 단축 또는 경쟁 제품 우위는 미입증**이다. 병렬 입장과 상한·순서 보존은 별도의 제어된 시험으로 확인했으므로 해당 구현은 유지했다.

공유 데스크톱에서 수행한 소규모 측정이므로 편차의 원인은 확정하지 않는다. 측정 중 일부 문서 편집으로 harnessDirty가 표시되지만 실행 패키지의 해시는 고정돼 있다. 추가로 엄격한 성능 판정이 필요하면 외부 부하를 통제하고 작업 유형을 나눈 시험이 필요하다.

## 이슈 정리와 남는 범위

상위 [#1663](https://github.com/shaun0927/openchrome/issues/1663#issuecomment-5571560523)에 확정 범위를 기록했다. 신규 task planner·실행 엔진·추측성 캐시·범용 scheduler 확장은 제외했고 #1651, #1657, #1658, #1659를 not planned로 종료했다. 나머지 구현 이슈는 PR 병합 전까지 열린 상태로 유지한다.

외부 사이트의 SSO/MFA와 실제 사용자 조작, 실제 호스트별 운영 환경, 장시간 메모리 안정성, 공개 릴리스 수용 시험은 이 fixture 결과에 포함되지 않는다. `human`은 추적하는 도구/CDP 명령의 종료를 뜻하며 웹사이트의 타이머·백그라운드 네트워크를 정지시키지 않는다. 프로세스 재시작 뒤 기존 조작권 lease가 유지된다고 보장하지 않는다.

## 증거와 재현

아래 원본은 로컬 `artifacts/frontier/`에 보존했다. CI 원본은 위 workflow의 artifacts에서 받을 수 있다. E-1/E-2는 제어된 기능 시험, E-3/E-4는 독립 fixture 서버의 효과 확인, E-5는 혼합 성능 판정, E-6은 설치 산출물 동일성의 근거다.

| 증거 | 파일 | SHA-256 |
|---|---|---|
| E-1 | `confirmed-final-tests.json` | `aa1d1f046c000ae9bd451f688080716b126c209530e9e69132a3b41146c9a6c9` |
| E-2 | `final-concurrency-test.json` | `e72668dc3c10bb08059cbd0faa0780c961e15e18325eacea0cf1db6e3d017edd` |
| E-3 | `final-installed-acceptance.json` | `d612a8de6df257bcf5daff7084a5bdbff1168fcec25e9fca52f70b84c78eecb2` |
| E-4 | `final-upgrade-acceptance.json` | `b277c01c03ba12e9bcef2f19d6c94dd3a97fa2c123bc3c38a16c385ae927d640` |
| E-5 | `final-benchmark-summary.json` | `a90793ae2dcbf310eb5553a826e17523746f6dcde1322ed1ed9f941de2372959` |
| E-6 | `final-dist-parity.json` | `9bb05f73ba25a11274b9d97e5df8bacf35bed78aa1938adb5c18bff2afc0e6ec` |

설치된 후보를 같은 방식으로 검증하는 명령은 다음과 같다. `CANDIDATE_ENTRY`와 `CANDIDATE_ARTIFACT`는 검사할 설치 엔트리와 tarball의 절대 경로다.

```powershell
npm run harness:frontier -- --runtime-contract --confirmed-scope --entry $env:CANDIDATE_ENTRY --artifact $env:CANDIDATE_ARTIFACT --output artifacts/frontier/reproduced-acceptance.json
```

업그레이드 재현은 [사용 가이드](agent/browser-control.md)의 `--upgrade-package` 및 `--upgrade-prefix` 절차를 따른다. 실제 사용자 프로필 대신 전용 임시 설치와 fixture 상태를 사용한다.
