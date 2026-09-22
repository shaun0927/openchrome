# 선택형 판단 평가

이 도구는 브라우저 action을 실행하는 모델 라우터가 아니라 오프라인 비교용 평가 기반이다.
합성 fixture와 로컬 fixture 실행에서 추출한 사례를 사용한다. 실제 사용 기록을 저장소에 추가하지 않는다.

```sh
npm run build
npm run eval:decisions -- --corpus tests/fixtures/decisions/pool-fixture.labeled.jsonl --out-dir artifacts/decision/local
npm test -- --runInBand tests/decisions tests/pilot/decider tests/harness/decision-fixture.test.ts
```

기본 provider는 noop와 기존 규칙 기반 regex다. file은 별도 정답 파일을 읽으며,
typesafe는 명시적으로 선택하고 키를 설정했을 때만 외부 API를 호출한다.
평가 입력에서 label과 truth_hint를 제거하며, 라벨 없는 사례는 채점에서 제외한다.
외부 provider를 선택하기 전에 corpus의 개인정보와 전송 권한을 확인한다.

`harness:decision-baseline`은 로컬 Chrome과 MCP를 사용하는 고정 시나리오다.
서버 receipt와 다운로드 해시로 결과를 판정하며, 호스트 LLM 토큰이나 실제 사용자 성능을 측정하지 않는다.
`extract-trajectory.ts`는 수동 개발 도구이며 민감할 수 있는 로컬 기록을 읽는다.
추출 결과는 artifacts 아래에서 검토하고 익명화한 뒤 사용한다.

모델 정확도, 안전성 또는 비용 개선은 이 기반의 존재만으로 입증되지 않는다.
