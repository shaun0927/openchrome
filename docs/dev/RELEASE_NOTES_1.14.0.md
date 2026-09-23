# OpenChrome MCP 1.14.0 릴리스 후보

상태: 게시 전 초안. npm publish와 정식 GitHub release 공개를 실행하지 않았다.
독립 검토 승인 및 후보의 main 병합 전에는 정식 배포용으로 승인된 패키지가 아니다.

비교 기준은 GitHub [v1.13.0](https://github.com/shaun0927/openchrome/releases/tag/v1.13.0)이다.
2026-09-23 확인 시 npm latest는 1.12.9였다. GitHub release와 npm 게시 여부는 별개다.
1.13.0에서 추가된 수동 브라우저 제어·컨텍스트별 저장 상태 복원·취소 개선은
이번 버전의 신규 기능으로 중복 계산하지 않는다.

## 업그레이드 시 달라지는 동작

- 자동 탐색은 정확히 같은 URL의 유일한 작업 탭만 재사용한다. 다시 로드하지 않아
  작성 중인 입력을 보존한다. 다른 URL로 이동하려면 tabId를 명시한다.
- 같은 URL 후보가 여러 개면 AMBIGUOUS_TAB으로 선택을 요청한다.
- 자동 복구에서 headed 창을 임의로 실행하지 않는다. HEADED_FALLBACK_REQUIRES_USER를
  받으면 사용자 의사를 확인한 후 allowHeadedFallback을 명시한다.
- 일반 attach 대상이 다른 브라우저 endpoint로 바뀌면 CHROME_IDENTITY_CHANGED로 거부한다.
- 기존 도구와 legacy initialize는 유지한다. 전체 stateless MCP v2 지원 릴리스가 아니다.

## Chrome 작업 흐름

### 작업 중인 창을 덜 방해하는 탭 생성

일반·격리 context의 자동화 탭을 CDP background 생성으로 만든다.
생성 실패 시 전면 탭 생성으로 우회하지 않으며, 닫힌 격리 context를 기본 context로 바꾸지 않는다.
최초 Chrome 실행, 운영체제 대화상자, 사용자가 명시적으로 요청한 활성화까지
항상 보이지 않게 만든다는 보장은 아니다.

### 기존 사용자 탭의 명시적 인계

OPENCHROME_USER_TABS=1로 켠 attach 서버에서 tabs_context(scope=browser)로 발견하고,
worker(action=borrow_tab)에 tabId와 관측한 expectedUrl을 지정해 인계한다.
release_tab으로 반환하며, borrowed 탭은 닫기·세션 종료·TTL 정리에서 닫지 않는다.
기본 context와 로컬 기본 tenant 범위다. 별도 서버 프로세스 간 전역 잠금은 없다.
Chrome 연결 성공이나 탭 발견만으로 사이트 로그인·계정 일치를 확인했다고 보고하지 않는다.

### 중복 탐색과 포커스 정책

tabId 없는 탐색을 세션·worker·profile·lane 단위로 직렬화한다.
같은 URL의 동시 요청에서 기존 작업 탭을 재사용한다.
OPENCHROME_FOCUS_POLICY=background-only는 명시적 tabs_activate, reveal, headed 실행도 거부한다.
기본 explicit-only는 사용자 요청에 따른 표시를 허용한다. 알 수 없는 값은 표시를 허용하지 않는다.

### 연결 진단과 실행 세대

oc_get_connection_info(host=openchrome)의 browserConnection으로 연결 상태와
해시 식별자를 확인한다. authentication=unverified는 로그인 검증이 아니라는 뜻이다.
initialize 응답의 capabilities.experimental.io.openchrome/runtime은 runtimeId와
실행 패키지 버전을 제공한다. params._meta의 io.openchrome/runtimeId를 보내는 클라이언트는
이전 실행 세대를 참조하는 요청에 STALE_RUNTIME을 받는다.
이 필드는 인증 토큰이 아니며 기존 권한 검사를 대체하지 않는다. 필드 미전송은 구형 호환 경로다.
신형 MCP 요청을 구형 세션 규칙으로 오실행하지 않도록 거부한다.
HTTP의 명시적 MCP-Protocol-Version은 광고하는 2024-11-05만 허용한다.
다른 버전을 고정한 클라이언트는 initialize의 응답 버전으로 맞춰야 한다.

## 로컬 bounded learning

이 기능군은 v1.13.0 이후 main에 병합된 PR #1667~#1671을 포함한다.

- OPENCHROME_LEARNING=1로 동의할 때만 로컬 이벤트를 저장한다. 기본값은 비활성이다.
- 저장 위치 기본값은 사용자 홈의 .openchrome/learning/events.jsonl이다.
- pilot contract runtime의 irreversible_policy와 outcome_failure_triage만 수집한다.
  모든 브라우저 도구 사용을 자동 학습 데이터로 수집하지 않는다.
- 허용 필드만 저장하며 원본 DOM·스크린샷·폼 값·URL·credential을 학습 이벤트에 저장하지 않는다.
- export는 무라벨·비식별 미적용·민감 표시·잘못된 선택지 레코드를 제외한다.
  동일 task/state/choices는 같은 train/holdout split에 배정한다.
- eval은 별도로 만든 예측을 채점한다. 정답 유출 없는 평가와 예측 출처는 운영자가 확인한다.
- adapter registry 상태는 candidate/shadow/assist/disabled이며 authority 상태는 없다.
  승격 시 원본 데이터와 예측으로 평가를 다시 확인한다.
- Laya 로컬 provider는 최대 20개 선택지의 개발용 평가 경로다. 모델 설치·가중치·환경이 필요하다.

finetune 명령은 blocked_scaffold 보고서만 만든다. 자동 온라인 학습·원격 업로드는 없으며,
registry 승격이 실제 브라우저 모델 실행을 활성화하지 않는다. 모델 정확도나 속도 향상을
실증했다고 주장하지 않는다. G3 preflight 실행 성공도 G3 closure 승인을 뜻하지 않는다.
G3·Laya 평가 스크립트는 소스 checkout용이며 npm 패키지에 포함되는 learning CLI와 구분한다.

## 설치·재연결

npm 설치만으로 이미 실행 중인 MCP 프로세스가 교체되지는 않는다.
사용자 탭 제어권을 반환하고 서버를 중단한 후 새 패키지로 시작한다.
호스트에서 MCP 연결과 도구 목록을 갱신하고 실행 버전·runtimeId·브라우저 대상을 다시 확인한다.
응답을 못 받은 클릭·제출은 결과 확인 없이 자동 재실행하지 않는다.
이전 tabId·lease가 유효하다고 가정하지 않는다. npm 게시 전에는 @latest가 이 후보를 제공하지 않는다.

## 검증과 공개 제한

후보 코드에서 TypeScript 빌드, 사용성 회귀 576개, transport 98개,
실제 Chrome background 생성 4개 테스트를 통과했다.
실제 MCP로 기존 탭 인계·닫기 거부·폼 보존·동시 탐색·포커스 전후 비교와
프로세스 재시작 후 오래된 요청 거부를 확인했다.
이는 실제 사용자 계정 SSO/MFA, 연속 키 입력 무손실, 장기 실행 안정성의 인증은 아니다.

1.14.0 tarball 생성, 별도 디렉터리 설치, CLI 버전 확인, npm publish --dry-run을 통과했다.
설치된 패키지의 headed MCP 포커스·재시작·탭 인계 테스트와 학습 테스트 65개도 통과했다.
isolated headless 시작 실패는 headless 실행에 --enable-automation을 추가해 수정했다.
수정 전 실패와 수정 후 실제 Chrome 수락 통과를 확인했으며, headed 실행 옵션은 변경하지 않는다.
checkout 밖에 설치한 패키지와 Windows/Linux GitHub 설치 수락 테스트도 통과했다.
전체 Jest에서 발견한 v1.13 도구 목록의 과거 스냅샷 누락은 기존 snapshot을 보존하고
oc_browser_control 추가를 명시하는 exact 비교로 수정했다.
독립 검토의 HTTP 지원 버전 불일치 지적도 수정하고 회귀 테스트를 추가했다.
초기 429는 검토 역할 미지정에 따른 Claude 기본 경로 문제였고 명시적 검토 역할로 복구했다.
최종 커밋의 검토·CI·main 병합 결과는 릴리스에 첨부하는 검증 기록에서 확인한다.
승인·병합·CI 통과 전 정식 공개를 보류하며 npm publish는 별도 실행 단계다.

## 참고

- [사용성 운영 절차](https://github.com/shaun0927/openchrome/blob/86ebc6b1e46e7cacf0d17b03e0d8832ccc7ae218/docs/dev/USABILITY_RELEASE.md)
- [Stateless 전환 범위와 미완료 항목](https://github.com/shaun0927/openchrome/blob/86ebc6b1e46e7cacf0d17b03e0d8832ccc7ae218/docs/dev/STATELESS_MIGRATION.md)
- [학습 운영 절차](https://github.com/shaun0927/openchrome/blob/86ebc6b1e46e7cacf0d17b03e0d8832ccc7ae218/docs/dev/RUNBOOK.md)
- [학습 데이터 관리](https://github.com/shaun0927/openchrome/blob/86ebc6b1e46e7cacf0d17b03e0d8832ccc7ae218/docs/dev/learning-pipeline.md)
