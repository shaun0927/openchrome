# 사용성 변경 검증과 배포

## 검증 명령

`npm run build` 후 `npm run test:usability`를 실행한다.
실제 브라우저 검증은 Windows 대화형 데스크톱에서 별도로 실행한다.
환경 변수 `OPENCHROME_TEST_CHROME`에 Chrome 실행 파일의 절대 경로를 지정한 뒤
`npm run test:usability:foreground`와 `npm run test:usability:user-tabs`를 실행한다.
이 명령은 임시 프로필과 로컬 페이지를 사용하며 실제 사용자 프로필을 수정하지 않는다.
최초 테스트 브라우저 실행은 창을 표시한다. 포커스 증거는 작업 전후 창 비교이며
연속 키 입력이나 모든 운영체제 대화상자에 대한 보장은 아니다.

## 기존 탭 사용

연결 가능한 Chrome에 attach한 서버에서 `OPENCHROME_USER_TABS=1`을 명시한다.
`tabs_context(scope=browser)`로 발견한 탭을 `worker(action=borrow_tab)`에
tabId와 정확한 expectedUrl을 지정해 인계한다. 작업 후 release_tab으로 반환한다.
인계는 로그인 인증을 증명하지 않는다. 사이트 계정은 별도 확인해야 한다.
일반 Chrome이 디버깅 연결을 제공하지 않는 경우 강제 재시작하거나 접근 제한을 우회하지 않는다.
서버 프로세스 사이의 전역 탭 소유권 잠금은 제공하지 않는다.

## 전면 표시

기본값 explicit-only는 명시적 활성화를 허용한다.
`OPENCHROME_FOCUS_POLICY=background-only`는 활성화와 reveal, 명시적 headed 실행을 거부한다.
자동 headed 복구는 사용자 개입 응답을 반환한다. 요청별 allowHeadedFallback을
명시한 경우에만 기존 복구를 허용하며 headless 설정은 계속 존중한다.

## 배포 게이트

각 후보의 정확한 커밋을 검토하고 테스트 증거를 기록한 뒤 의존 순서로 병합한다.
검토 서비스 오류는 통과가 아니다. 최종 main에서 빌드와 위 검증을 다시 수행한다.
`npm pack --dry-run`으로 배포 파일을 확인하고 `npm whoami`로 게시 계정을 확인한다.
버전과 npm 등록 여부를 확인한 뒤 최종 main에서만 npm publish를 실행한다.
태그와 배포 완료 주장은 실제 registry 조회 결과가 있을 때만 기록한다.

## 설치와 같은 대화에서 재연결

npm 설치는 디스크의 패키지를 변경할 뿐 이미 실행 중인 MCP 서버를 교체하지 않는다.
작업 중인 탭의 제어권을 반환하고 서버를 중단한 후 최신 패키지로 다시 실행해야 한다.
호스트의 MCP 재연결 또는 설정 reload 기능으로 도구 목록도 새로 받아야 한다.
고정 버전 명령이나 다른 경로의 전역 실행 파일을 사용하는지 확인한다.
재연결 후 패키지 버전과 연결 진단을 확인하고 기존 tabId와 lease를 그대로 재사용하지 않는다.
이 구현은 서버의 세션과 탭 소유 상태를 없애는 stateless v2 전환이 아니다.
같은 대화에서의 교체 가능 여부는 호스트의 reload 지원과 실제 설정에 달려 있다.
