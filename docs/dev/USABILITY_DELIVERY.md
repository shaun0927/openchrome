# Chrome 사용성 개선 진행 기록

기준 main: `43d99a01ea9a7abba080e20d1f142edafe4fa258`.
기존 작업 트리는 보존하고 별도 worktree에서 작업한다.

| 순서 | 변경 | 상태 |
|---|---|---|
| 1 | 백그라운드 탭 생성 | 구현 및 로컬 headed QA 완료, 검토 대기 |
| 2 | 연결 대상 식별과 진단 | 구현 및 MCP QA 완료, 검토 대기 |
| 3 | 기존 탭 발견과 제어권 인계 | 구현 및 MCP QA 완료, 검토 대기 |
| 4 | 작업 탭 선택과 중복 생성 방지 | 대기 |
| 5 | 포커스 정책과 사용자 개입 흐름 | 대기 |
| 6 | headed 회귀 검증과 운영 문서 | 대기 |

각 PR은 빌드, 관련 테스트, 실제 경로 QA, 독립 검토 후 순서대로 병합한다.
일반 Chrome의 디버깅 연결 제한을 우회하거나 사용자 Chrome을 강제로 재시작하지 않는다.
테스트는 별도 임시 프로필과 로컬 페이지를 사용한다. 사용자 쿠키와 토큰을 수집하지 않는다.

## PR 1 검증

- `npm run build`: 통과.
- 기존 생성 및 headed fallback 관련 4개 suite / 46개 테스트: 통과.
- `OPENCHROME_TEST_CHROME`과 `OPENCHROME_TEST_HEADED=1`로 실행한
  `tests/cdp/background-page.test.ts`: 실제 Chrome에서 4개 테스트 통과.
- `scripts/verify-background-tabs.cjs`: Windows Chrome 153.0.8010.50,
  MCP stdio 경유 일반 생성 2회와 격리 context 생성 1회 후 foreground 유지 확인.
- 증거: 로컬 `artifacts/usability/`의 build.log, headed-tests.log, mcp-foreground.log.
- 관측은 호출 전후 foreground 창 비교다. 연속 키 입력 무손실이나 모든 OS 대화상자까지
  검증한 것은 아니며, 최초 Chrome 실행은 별도 창을 띄운다.
- 기본 context를 유지하고, 닫힌 격리 context 요청을 기본 context로 우회하지 않는다.

## PR 2 범위

일반 explicit attach는 최초 연결한 브라우저 endpoint를 고정한다. 캐시 무효화 후
같은 포트에 다른 브라우저가 나타나면 `CHROME_IDENTITY_CHANGED`로 거부한다.
프로필 디렉터리를 검증하는 기존 auto-connect 재연결 정책은 유지한다.
`oc_get_connection_info(host=openchrome)`의 `browserConnection`이 실제 연결 상태,
해시 식별자, 프로필 검증 한계, 인증 미검증 상태를 반환한다.
기존 `mode`는 호환성을 위해 유지하며 브라우저 연결 판정에는 사용하지 않는다.
단순 포트 연결만으로 프로필이나 사이트 로그인 계정이 확인됐다고 보고하지 않는다.

## PR 3 사용 계약

서버 실행 시 `OPENCHROME_USER_TABS=1`을 명시해야 기존 사용자 탭 접근을 허용한다.
첨부된 브라우저의 기본 context와 로컬 기본 tenant만 지원한다. 다른 worker의 소유 탭,
격리 context, 별도 프로필 worker는 자동 인계 대상이 아니다.

1. `tabs_context`에 `scope: "browser"`를 보내 기존 미소유 HTTP(S) 탭을 발견한다.
2. `worker`에 `action: "borrow_tab"`, `tabId`, 관측한 정확한 `expectedUrl`을 보낸다.
3. 작업 후 `action: "release_tab"`, `tabId`로 제어권을 반환한다.

인계된 탭은 `tabs_close`로 닫지 않으며 세션 삭제와 TTL 정리 시 제어권만 반환한다.
opt-in 모드에서는 미소유 tabId를 일반 도구에 보내도 자동 복구 명목으로 인계하지 않는다.
서로 다른 OpenChrome 서버 프로세스 사이의 전역 잠금은 이 PR의 보장 범위가 아니다.
`scripts/verify-user-tabs.cjs`로 실제 MCP 발견, stale URL 거부, 인계, 닫기 거부,
제어권 반환, 서버 종료 후 탭 보존을 확인했다. 관련 session 테스트 107개 통과.
