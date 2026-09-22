# 1.14.0 게시 전 검증

확인일: 2026-09-23. npm 게시 전 검증 절차와 증거 목록이다.
최종 SHA의 승인·CI·병합 결과는 릴리스 첨부 검증 기록으로 확정한다.

| 작업 | 상태 | 근거 |
|---|---|---|
| package.json 및 lockfile 버전 | 완료 | 1.14.0, 의존성 변경 없음 |
| 이전 릴리스 비교 | 완료 | v1.13.0 이후 learning PR #1667~#1671 및 사용성 후보 7개 |
| TypeScript 빌드·pack | 통과 | artifacts/usability/pack-1.14.0.json |
| 격리 설치·CLI 버전 | 통과 | install-1.14.0.log, CLI 출력 1.14.0 |
| npm publish dry-run | 통과 | publish-dry-run-1.14.0.json, 실제 publish 아님 |
| 설치된 패키지 headed MCP | 통과 | installed-headed-1.14.0.log, installed-user-tabs-1.14.0.log |
| 학습 회귀 | 통과 | learning-release-tests.log, 11 suites / 65 tests |
| isolated headless 설치 수락 | 수정 후 통과 | final-installed-acceptance.json, checkout 외부 설치 |
| main 기준 동일 실패 비교 | 재현 후 수정 | baseline-acceptance.json, headless 전용 automation 플래그로 해결 |
| 독립 검토 | 실행 복구·지적 수정 | 명시적 gate reviewer 역할, HTTP 버전 불일치 수정 |
| PR·main 병합 | 최종 gate 확인 필요 | 릴리스 첨부 기록 참조 |
| npm publish | 미실행 | 요청 범위 밖, 기존 인증도 없음 |

로컬 증거 경로는 이 worktree의 artifacts/usability 아래다. 원시 로그에는 로컬 경로가
들어 있으므로 공개 릴리스에는 요약과 의도적으로 선택한 패키지만 첨부한다.
Biome LSP는 설치되지 않아 사용하지 않았다. TypeScript 빌드는 별도로 통과했다.

## 남은 게시 게이트

1. 최종 패키지의 Chrome 수락 시나리오를 통과시킨다.
2. 최종 커밋의 독립 검토에서 실질적 판정을 받는다. 지적 수정 전 판정을 재사용하지 않는다.
3. 지적 수정 후 관련 검증을 반복하고 PR·CI·main 병합을 진행한다.
4. 최종 main으로 패키지를 다시 만들고 설치 및 수락 검증을 반복한다.
5. 릴리스 초안의 대상 SHA와 패키지 해시를 일치시킨다.
6. 별도 게시 요청과 인증이 준비됐을 때만 npm publish와 정식 릴리스 공개를 실행한다.

## 버전 판단

1.13.0 GitHub release가 이미 존재하므로 같은 버전을 재사용하지 않는다.
새 opt-in 탭 인계, 진단, 학습 CLI 등 기능 추가를 포함해 1.14.0으로 준비한다.
이 버전 번호는 stateless MCP v2 지원이나 npm 게시 완료를 뜻하지 않는다.
