# Chrome 사용성 개선 진행 기록

기준 main: `43d99a01ea9a7abba080e20d1f142edafe4fa258`.
기존 작업 트리는 보존하고 별도 worktree에서 작업한다.

| 순서 | 변경 | 상태 |
|---|---|---|
| 1 | 백그라운드 탭 생성 | 구현 및 로컬 headed QA 완료, 검토 대기 |
| 2 | 연결 대상 식별과 진단 | 대기 |
| 3 | 기존 탭 발견과 제어권 인계 | 대기 |
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
