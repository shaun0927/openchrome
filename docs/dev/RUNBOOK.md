# 학습 운영 절차

```sh
npm ci
npm run build
npm run learning -- status --json
npm test -- --runInBand tests/decisions tests/pilot/decider tests/pilot/learning
npm run preflight:g3
```

수집은 `OPENCHROME_LEARNING=1`로 명시적으로 켠다. 기본 디렉터리는 사용자 홈의
`.openchrome/learning`이다. pilot contract 경로에서만 이벤트가 생성되며
비가역 이벤트는 unlabeled, 실패 결과는 heuristic 라벨이다.

1. 이벤트를 검토하고 별도 정답을 host/user 라벨로 부여한다.
2. learning export/validate로 개인정보와 선택지를 검사한다.
3. 별도 로컬 학습 환경에서 명시적으로 학습한다. OpenChrome은 학습 실행기를 제공하지 않는다.
4. holdout 정답을 모델에 보여주지 않고 예측 manifest를 만든다.
5. learning eval로 채점하고 원본 파일과 adapter 해시를 보존한다.
6. registry-promote를 명시적으로 실행한다. 현재는 registry 상태만 바뀐다.

명령 인수는 [파이프라인 문서](learning-pipeline.md)를 따른다.
예측 파일의 출처·학습/평가 분리·실제 adapter 해시는 운영자가 검증해야 한다.

G3 스크립트는 `scripts/decisions`의 개발용 평가 도구다. 일부 보고서는 이전 로컬 실험의
입력 파일과 ledger가 필요하다. 없는 자료를 승인된 결과로 만들지 않는다.
`preflight:g3`는 새 checkout에서도 누락 증거를 false로 보고한다.
명령 종료 코드 0은 보고서 생성 성공이며 G3 종료는 `ok_to_close` 값으로 판단한다.
기존 세션별 g3 보고서 생성기는 과거 분석 도구이므로 현재 성능 인증으로 사용하지 않는다.
