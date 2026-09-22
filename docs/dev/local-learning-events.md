# 로컬 학습 이벤트

기본값은 비활성이다. `OPENCHROME_LEARNING=1`과 `OPENCHROME_LEARNING_MODE=local_only`로 수집에 동의한다.
기본 저장소는 홈 디렉터리의 `.openchrome/learning/events.jsonl`이다.
`OPENCHROME_LEARNING_DIR`, `OPENCHROME_LEARNING_STORE`로 위치를 바꿀 수 있다.
`OPENCHROME_LEARNING_TASKS`는 `irreversible_policy,outcome_failure_triage`만 허용한다.
빈 목록·잘못된 task는 수집하지 않으며, 지원하지 않는 mode도 비활성 처리한다.

현재 연결은 pilot contract runtime의 비가역 판단과 실패 결과에 한정된다.
일반 도구 호출 전체를 자동 수집하거나 Laya 추론을 실행하지 않는다.
기록 실패는 기존 실행 결과를 바꾸지 않으며 비동기 append 특성상 즉시 프로세스를 종료하면 마지막 이벤트가 유실될 수 있다.

저장 상태는 허용된 verdict·오류 분류·증거 종류·성공 여부·시간·재시도 수만 남긴다.
원본 DOM·스크린샷·폼 값·URL·자유 텍스트·사용자 식별자는 저장하지 않는다.
비가역 판단은 라벨 없이 기록하고 실패 라벨은 heuristic 출처로 명시한다.
이 데이터만으로 독립 정답이나 모델 성능 향상을 주장할 수 없다.

자동 삭제·원격 업로드·백그라운드 fine-tuning은 없다.
수집을 중지하려면 opt-in을 해제한다. 기존 로컬 데이터는 사용자가 삭제하기 전까지 남는다.
