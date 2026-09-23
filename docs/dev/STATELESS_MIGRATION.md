# Stateless 전환 규약

확인일: 2026-09-23. 추적 이슈: #1673. 이 문서는 계층별 구현 상태와 남은 요구사항을 구분한다.
지원 범위와 메서드 matrix의 기준 문서는 [docs/mcp-2026-07-28.md](../mcp-2026-07-28.md)이며,
matrix는 `src/mcp/protocol-matrix.ts`와 테스트로 동기화된다.

## 기준

공식 MCP 2026-07-28은 요청별 메타데이터와 명시적 애플리케이션 식별자를 요구한다.
연결은 대화의 식별자가 아니며 서버발 요청은 multi round-trip(`input_required`)으로 바뀐다.
SDK v2라는 패키지 이름, MCP 프로토콜 버전, OpenChrome 패키지 버전은 서로 다른 개념이다.

출처: [기본 규약](https://modelcontextprotocol.io/specification/2026-07-28/basic),
[버전 호환성](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
[전송 규약](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports),
[변경 이력](https://modelcontextprotocol.io/specification/2026-07-28/changelog).

## 결정

- 프로토콜 경계는 공식 TypeScript SDK 2.x(`@modelcontextprotocol/server`, `@modelcontextprotocol/node`)가 맡는다.
  develop에만 병합됐던 #1598의 설계를 현재 main 구조로 이식했다. Node.js 하한은 20이다.
- stdio 상대는 로컬 클라이언트다. MCP 세션 id 없이 기존 `default` 브라우저 세션을 쓰며 legacy와 modern 모두 SDK가 처리한다.
- HTTP legacy는 세션형 경로(initialize, `Mcp-Session-Id`, GET/SSE, DELETE)를 유지하고 2024-11-05만 협상한다.
  HTTP modern은 SDK가 분류·검증한 뒤 무상태로 처리하며 `Mcp-Session-Id`를 발급·반사·해석하지 않는다.
- modern `tools/list`는 연결별 progressive disclosure 없이 권한·설정으로만 거른 전체 목록을 반환한다.
- 서버발 메시지(진행, 로그, 목록 변경, 서버→클라이언트 요청)는 요청한 클라이언트에게만 전달한다.

## 계층별 상태

| 계층 | 상태 | 근거 |
|---|---|---|
| 서버발 메시지 격리 | 구현 | 세션 없는 HTTP 요청의 broadcast 누출 수정, dual owner 라우팅 (#1674) |
| 프로토콜 어댑터 | 구현 | `src/mcp/sdk-adapter.ts`, `server/discover`, `resultType`, cache hint, 오류 코드(-32020/-32021/-32022) |
| 요청 컨텍스트 | 구현 | version/capabilities/clientInfo/logLevel을 요청 envelope에서 해석, legacy는 initialize 결과를 같은 형태로 전달 |
| HTTP | 구현 | modern header/body 일치 검증은 SDK, legacy 경로는 협상 버전 외 `MCP-Protocol-Version` 거부 |
| 알림 | 구현 | modern은 `subscriptions/listen`(HTTP는 tenant 한정), legacy는 세션별 SSE |
| 브로커 | 구현 | modern 요청 헤더 생성, 세션 비고정, SSE 증분 중계, 취소 시 스트림 종료, legacy 세션 GET 스트림 중계 |
| 사용자 개입 | 구현 | 서버→클라이언트 요청을 `input_required`로 변환. `requestState`는 HMAC 서명·만료·호출 주체/메서드 바인딩, 도구·인자 해시 바인딩, 1회 사용, 요청하지 않은 응답 무시 |
| 브라우저 작업 | 구현 | `oc_workspace`가 발급한 handle만 modern 브라우저 도구에 사용. 누락·만료·타 tenant·이전 runtime handle은 브라우저 동작 전 거부, 연결과 무관하게 같은 handle 재사용 |
| 배포·교체 | 구현 | 종료 시 drain(새 호출 `SERVER_DRAINING` 거부, 실행 중 호출 기한 대기 후 결과 불명 보고), 이전 runtime handle·runtimeId를 브라우저 동작 전 거부, `openchrome doctor`의 running-version 검사, 호스트별 재연결 절차 |

## 클라이언트 재연결 계약

1. 설치 버전이 아닌 initialize 또는 `server/discover`의 `io.openchrome/runtime`에서 packageVersion과 runtimeId를 확인한다.
2. 재연결 때 runtimeId가 달라지면 도구 목록과 브라우저 진단을 다시 읽는다.
3. 기존 tabId·lease·application session을 유효하다고 가정하지 않는다.
4. 사용자 탭은 다시 발견하고 expectedUrl을 검증해 명시적으로 인계한다.
5. 응답을 받지 못한 클릭·제출 등은 결과를 관찰한 후 재시도 여부를 결정한다.

runtimeId는 인증 수단이 아니며 tenant 권한, 탭 소유권, lease 검사를 대체하지 않는다.
연결 독립성과 프로세스 재시작 후 영속성은 별개다. 무중단 업그레이드나 영구 handle 보존은 약속하지 않는다.

## 진행 상태

1.15.0 후보(`release/1.15.0-prepublish`)에서 위 계층이 모두 구현됐다. 스택 PR은 #1674(격리) → #1675(SDK 경계) →
#1676(workspace handle) → #1677(서명된 requestState) → #1678(drain) → 릴리스 PR 순서로 병합한다.
각 PR은 독립 검토를 거쳤고 지적 사항을 반영한 뒤 재검토에서 승인됐다. PR 병합은 저장소 관리자가 수행한다.

1.14.0과 1.13.0은 npm에 게시되지 않았다(npm latest 1.12.9). npm publish는 이 전환 작업 범위 밖이며
관리자 인증과 별도 요청이 있을 때만 실행한다.

#1673 종료 기준과 증거는 [PREPUBLISH_1.15.0.md](PREPUBLISH_1.15.0.md)에 정리한다.
