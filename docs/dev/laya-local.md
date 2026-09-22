# Laya 로컬 평가

`laya-local`은 평가 스크립트 전용 provider다. 브라우저 action 권한과 런타임 라우팅은 없다.
선택지는 abstention을 포함해 최대 20개다. 초과한 사례는 abstain 처리한다.

Laya 패키지가 설치된 Python 실행 파일을 `LAYA_PYTHON`으로 지정하고
`LAYA_LOCAL_ENABLED=1`을 명시적으로 설정한다. `LAYA_MODEL` 기본값은 `typed-decisions`다.
모델 가중치가 캐시에 없으면 Laya 라이브러리가 다운로드할 수 있다.
오프라인 사용은 가중치를 미리 준비하고 해당 라이브러리의 오프라인 설정을 사용한다.

```sh
LAYA_LOCAL_ENABLED=1 npm run eval:decisions -- --corpus tests/fixtures/decisions/pool-fixture.labeled.jsonl --provider laya-local --kind irreversible --out-dir artifacts/decision/laya
```

초기화와 각 추론 요청은 120초 후 중단한다. worker 실행 실패·잘못된 JSON·종료는 오류로 기록한다.
프로토콜 테스트는 작은 대체 worker를 사용하므로 모델 정확도나 실제 Laya 설치 호환성을 입증하지 않는다.
실제 모델 평가 결과와 가중치·장치·실행 환경을 별도로 기록해야 한다.
fine-tuning 및 adapter 자동 승격은 이 provider의 기능이 아니다.
