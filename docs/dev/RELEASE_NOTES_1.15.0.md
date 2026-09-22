# OpenChrome MCP 1.15.0 릴리스 후보

상태: 게시 전 초안. npm publish와 정식 GitHub release 공개를 실행하지 않았다.
스택 PR(#1674~#1679)이 main에 병합되기 전에는 정식 배포용으로 승인된 패키지가 아니다.

비교 기준은 main에 병합된 1.14.0(`86ebc6b`)이다. 1.14.0과 1.13.0은 GitHub에만 있고
2026-09-23 확인 시 npm latest는 1.12.9다. npm 사용자는 1.12.9에서 바로 1.15.0으로 올라온다.
추적 이슈: #1673.

## 요약

MCP 2026-07-28(stateless) 규약을 stdio와 HTTP 모두에서 legacy(initialize 기반) 클라이언트와 함께 제공한다.
프로토콜 경계는 공식 TypeScript SDK 2.x가 맡고, OpenChrome 코어는 브라우저 상태·도구·권한을 그대로 담당한다.
modern 요청은 연결에서 어떤 상태도 추론하지 않으며, 브라우저 상태는 서버가 발급한 workspace handle로만 참조한다.

## 업그레이드 시 달라지는 동작

- **Node.js 20 이상이 필요하다**(SDK 2.x 요구사항). Node 18에서는 설치·실행되지 않는다.
- **stdio는 공식 SDK가 처리한다.** legacy 클라이언트는 SDK가 2024-10-07~2025-11-25 중에서 버전을 협상한다.
  stdio 클라이언트는 여전히 로컬 클라이언트이며 `default` 브라우저 세션을 쓴다.
- **stdio에서 취소한 요청에는 응답하지 않는다.** MCP 규약(2025 세대 SHOULD NOT, 2026-07-28 MUST NOT)을 따른 변경이다.
  이전에는 `execution: "unknown"` 결과를 보냈다. 세션형 legacy HTTP는 계속 그 결과를 보낸다.
- **세션 없는 HTTP 요청**(`Mcp-Session-Id` 없음)은 서버발 알림·요청을 받지 않는다. 다른 클라이언트의 SSE 스트림으로 새지 않는다.
  resources/subscribe도 거부한다.
- **legacy HTTP는 `ping`에 응답**하고, 협상 버전(2024-11-05) 외의 `MCP-Protocol-Version`은 `-32600`으로 거부한다.
- **tools/list는 호출자의 scope로 거른다**(legacy·modern 공통). 알 수 없는 리소스 읽기는 `-32602`다.
- runtime 계약(`io.openchrome/runtime`)이 `contractVersion: 2`, `protocolMode: "dual-era"`, 전송별 `protocolSupport`로 바뀐다.
- 종료 시 drain한다. 새 도구 호출은 `SERVER_DRAINING`으로 거부하고, 실행 중 호출은 `OPENCHROME_DRAIN_TIMEOUT_MS`(기본 10초)까지 기다린다.

## MCP 2026-07-28

자세한 내용은 [docs/mcp-2026-07-28.md](../mcp-2026-07-28.md)에 있다.

- `server/discover`, 요청별 `_meta` envelope, `resultType`, 목록·읽기 cache hint를 제공한다.
  오류 코드는 -32020(헤더 불일치), -32021(capability 누락), -32022(미지원 버전)이다.
- HTTP modern 요청은 `MCP-Protocol-Version`·`Mcp-Method`·`Mcp-Name`을 본문과 대조해 검증하고,
  `Mcp-Session-Id`를 발급·반사·해석하지 않는다. GET/DELETE는 legacy 전용이다.
- 변경 알림은 `subscriptions/listen`으로 받는다(HTTP는 tenant 한정). 진행·로그는 요청 스트림에만 흐르며,
  로그는 요청에 `logLevel`이 있을 때만 보낸다.
- **workspace handle**: 브라우저 도구는 `oc_workspace`(open/list/close)가 발급한 `workspace` 인자를 요구한다.
  누락·만료·타 tenant·이전 프로세스 handle은 브라우저 동작 전에 거부한다.
  close는 write scope가 필요하고, 사람이 제어 중인 workspace는 만료되지 않는다.
- **서버→클라이언트 입력(MRTR)**: elicitation·sampling·roots는 `input_required`로 바뀐다.
  `requestState`는 HMAC 서명·만료·호출 주체(JWT는 subject) 바인딩, 도구·인자 해시 바인딩, 질문 내용 바인딩, 1회 사용이다.
  요청하지 않은 응답은 무시한다.
- **broker**: stdio 호스트가 broker를 거쳐도 modern 헤더를 붙이고, SSE를 도착 즉시 중계하며, 취소를 스트림 종료로 바꾼다.
  legacy 호스트는 세션 GET 스트림을 받아, broker 뒤에서도 진행 알림과 elicitation이 전달된다(이전에는 전달되지 않았다).

## 격리 수정

- 세션 없는 HTTP 요청의 progress·elicitation이 다른 클라이언트 SSE로 broadcast되고, 다른 클라이언트의 응답이 수락되던 문제(재현됨)를 고쳤다.
- dual stdio+HTTP owner(기본 auto-elect broker owner)에서 HTTP 클라이언트의 메시지가 stdio 호스트로 가던 문제를 고쳤다.
  공개 API `openchrome/server`의 `both` 모드도 같은 경로를 쓰고, stop() 시 HTTP listener를 닫는다.
- `notifications/resources/*`에서 `"id": null`을 제거했다. 공식 SDK 파서가 이 알림을 거부하고 있었다.
- 세션 없는 HTTP 요청의 취소 키가 stdio 클라이언트와 겹쳐, 같은 JSON-RPC id가 충돌하거나 다른 클라이언트를 취소할 수 있던 문제를 고쳤다.

## 운영

- `openchrome doctor`의 `running-version`은 실행 중 owner와 설치 버전이 다르면 경고한다.
  npm 업데이트만으로 실행 중인 서버는 바뀌지 않는다.
- 호스트별 재연결 절차(Claude Code, Codex CLI, OpenCode, HTTP daemon, broker)는
  [docs/mcp-2026-07-28.md](../mcp-2026-07-28.md#reconnecting-a-host)에 있다.

## 범위 밖

- 무중단 업그레이드와 프로세스 간 handle 영속성은 제공하지 않는다. 재시작하면 workspace를 다시 연다.
- 여러 daemon 간 round-robin 브라우저 제어는 지원하지 않는다. 브라우저 세션은 한 프로세스에 속한다.
- Tasks 확장과 MCP Apps는 채택하지 않았다.
- 공식 conformance 스위트(0.1.16)에는 아직 2026-07-28 시나리오가 없다. modern 규약은 공식 SDK v2 클라이언트 기반 테스트로 검증했다.

## 관련 문서

- [MCP 2026-07-28 지원](https://github.com/shaun0927/openchrome/blob/release/1.15.0-prepublish/docs/mcp-2026-07-28.md)
- [Stateless 전환 상태](https://github.com/shaun0927/openchrome/blob/release/1.15.0-prepublish/docs/dev/STATELESS_MIGRATION.md)
- [게시 전 검증](https://github.com/shaun0927/openchrome/blob/release/1.15.0-prepublish/docs/dev/PREPUBLISH_1.15.0.md)
