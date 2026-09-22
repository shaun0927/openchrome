# Stateless 전환 규약

확인일: 2026-09-23. 이 문서는 구현 상태와 후속 전환 요구사항을 구별한다.

## 확인한 차이

공식 MCP 2026-07-28은 요청별 메타데이터와 명시적 애플리케이션 식별자를 요구한다.
연결이 대화의 식별자가 아니며 서버발 요청은 새 메시지 패턴으로 바뀐다.
SDK v2라는 이름과 프로토콜 버전은 별개다. 현재 OpenChrome은 자체 프로토콜 서버이며
initialize에서 2024-11-05를 반환한다. HTTP 세션, capability 캐시, 브라우저 세션도 유지한다.

출처: [기본 규약](https://modelcontextprotocol.io/specification/2026-07-28/basic),
[버전 호환성](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
[전송 규약](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports).

## 이번 구현

- initialize의 capabilities.experimental에 io.openchrome/runtime을 추가했다.
- runtimeId는 MCPServer 인스턴스별로 바뀌며 설치 버전과 실행 중인 packageVersion을 구분한다.
- 클라이언트는 각 요청의 params._meta에 io.openchrome/runtimeId를 전달할 수 있다.
  이전 실행 세대를 보내면 STALE_RUNTIME으로 도구 실행 전 거부한다.
  미전송은 구형 호환 경로이므로 모든 오래된 요청을 막는다고 보장하지 않는다.
- 신형 protocolVersion/clientCapabilities 메타데이터는 구형 상태로 실행하지 않는다.
  HTTP 헤더 또는 본문에 신형 규약이 있으면 세션 할당과 dispatch 전 400으로 거부한다.
  구형 오류를 반환해 dual-era 클라이언트의 initialize fallback을 허용한다.
- runtimeId는 인증 수단이 아니다. tenant 권한, 탭 소유권, lease 검사를 대체하지 않는다.
- 기존 브라우저 상태를 자동 복구하거나 실패한 mutation을 자동 재실행하지 않는다.

## 목표 아키텍처와 후속 변경

| 계층 | 변경 | 완료 판정 |
|---|---|---|
| 프로토콜 어댑터 | legacy와 modern 경로를 분리하고 server/discover, resultType, 오류 매핑 구현 | 공식 스키마와 양쪽 클라이언트 conformance |
| 요청 컨텍스트 | version/capabilities/clientInfo/logLevel을 요청에서만 해석 | 같은 연결의 교차·동시 요청 간 누출 없음 |
| 브라우저 작업 | 명시적 application session handle로 소유권 참조, modern에서 default/transport session 추론 금지 | 식별자 누락 거부, tenant 간 접근 거부 |
| 사용자 개입 | sampling/elicitation/roots를 MRTR로 변경 | input_required 후 재개·만료·중복 입력 검증 |
| 알림 | 연결별 전역 알림 대신 요청별 subscriptions/listen | 구독 종료·취소 후 전송 없음 |
| HTTP | 요청 body/header 일치 검증, modern 세션 헤더 제거 | 불일치와 누락 거부, legacy 병행 동작 |
| 브로커 | modern metadata 보존, 세션 쿠키와 분리 | 새 연결에서도 같은 명시적 handle만 사용 |
| 배포·교체 | 요청 drain, 제어권 반환, 새 프로세스 시작, 재발견 | 이전 runtime 요청 거부, 미확정 쓰기 재실행 없음 |

Chrome/CDP 연결과 lease는 애플리케이션 상태로 남긴다. 이를 없애면 매 요청마다
브라우저를 띄우거나 탭 소유권을 잃을 수 있다. 프로토콜 무상태화와 별도 수명으로 관리한다.
현 단계에서 연결 간 handle 영속성이나 무중단 업그레이드는 구현되지 않았다.
위 전환과 conformance가 완료되기 전에는 2026-07-28 지원을 광고하거나 기본값으로 켜지 않는다.

## 클라이언트 재연결 계약

1. 설치 버전이 아닌 initialize의 packageVersion과 runtimeId를 확인한다.
2. 재연결 때 runtimeId가 달라지면 도구 목록과 브라우저 진단을 다시 읽는다.
3. 기존 tabId·lease·application session을 유효하다고 가정하지 않는다.
4. 사용자 탭은 다시 발견하고 expectedUrl을 검증해 명시적으로 인계한다.
5. 응답을 받지 못한 클릭·제출 등은 결과를 관찰한 후 재시도 여부를 결정한다.

## 진행 상태

전환 기반 구현과 별도로 전체 stateless 전환은 미완료다.
기존 6개 사용성 후보 및 이 변경 모두 독립 검토 승인 전이다.
검토 서비스 429로 PR 생성·병합은 차단됐고 npm 게시 인증도 아직 확인되지 않았다.
