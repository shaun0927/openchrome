# 학습 데이터 관리

빌드 후 `npm run learning -- status --json` 또는 `node dist/index.js learning status`를 사용한다.
`export --store <events.jsonl> --out-dir <dir> --task irreversible_policy`는 host/user 라벨만 기본 포함한다.
`--label-sources host,user,test,heuristic`는 출처를 명시적으로 확장한다. heuristic 라벨은 독립 정답이 아니다.
라벨 없음·비식별 미적용·허용되지 않은 상태·task 선택지 오류·파싱 오류는 제외하며 보고서에 집계한다.
`contains_sensitive`는 저장된 이벤트의 잔존 민감 정보 표시다. true인 외부 자료는 제외한다.
제품 저장 경로는 허용 필드만 새로 구성한 뒤 false로 기록한다.
동일한 task/state/choices는 같은 split으로 묶는다. id나 라벨을 바꿔도 같은 상태가 train/holdout 양쪽에 들어가지 않는다.

`eval`은 사용자가 별도로 생성한 예측 파일을 채점한다. 모델 실행이나 training은 하지 않는다.
예측 manifest는 `adapter_id`, `artifact_sha256`, `dataset_sha256`, `answers: [{id, answer, confidence}]`를 가진다.
예측 생성 시 label과 deterministic_answer를 모델에 전달하지 않아야 한다.
파일의 출처를 자동 인증하지 않으므로 동일 파일에서 정답을 복사한 결과는 유효한 성능 근거가 아니다.

```sh
npm run learning -- eval --dataset holdout.jsonl --predictions predictions.json --adapter local-v1 --artifact-sha256 <64-hex> --out-dir artifacts/learning-eval
npm run learning -- registry-list --registry registry.json
npm run learning -- registry-promote --registry registry.json --adapter local-v1 --status shadow --eval-report artifacts/learning-eval/eval-report.json --dataset holdout.jsonl --predictions predictions.json
```

registry는 `schema_version: 1`과 `adapters` 배열을 가진다. 후보를 파일에 명시적으로 등록한다.
항목은 id, task, base_model, artifact_sha256, status(candidate), created_at,
metrics(accuracy, highConfidencePrecision, abstainRate)를 가진다.
승격은 보고서를 그대로 신뢰하지 않고 원본 dataset/predictions로 다시 평가한다.
현재 최소 기준은 50개 독립 라벨, 모든 task 클래스 포함, confidence 0.9 이상 20건,
그 precision 0.95 이상, 기존 규칙 대비 accuracy 비열등, unsafe allow 0건이다.
이는 초기 운영 기준이며 G3 임계값 승인이나 실사용 성능 입증을 대신하지 않는다.

상태는 candidate/shadow/assist/disabled뿐이다. registry와 combiner는 아직 실제 모델 실행 경로에 연결되지 않았다.
승격 명령은 브라우저 동작을 활성화하지 않는다. combiner는 기존 정책을 완화할 수 없다.
`finetune --out-dir <dir>`는 blocked_scaffold 보고서만 생성한다. 자동 학습·원격 업로드는 없다.
