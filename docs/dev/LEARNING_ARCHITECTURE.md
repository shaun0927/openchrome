# 학습 아키텍처

제품 기본값은 learning disabled다. 명시적 opt-in 시 pilot contract runtime에서
비가역 정책 판단과 실패 결과의 허용된 요약 상태만 JSONL로 기록한다.
브라우저 action의 권한은 기존 deterministic 정책에 남는다.

현재 데이터 흐름은 다음과 같다.

1. local_only opt-in 확인과 task allowlist 적용.
2. 이벤트 작성과 저장 경계에서 원본 브라우저 값 제거.
3. host/user 라벨을 별도로 부여한 자료만 기본 export.
4. 상태 그룹별 train/holdout 분할과 제외 내역 보고.
5. 별도로 생성한 예측 파일을 독립 라벨로 채점.
6. adapter·dataset 해시와 원본 예측을 재검증한 명시적 registry 승격.

Laya는 개발용 오프라인 평가 worker다. 실제 모델 호출과 registry/combiner의
브라우저 runtime 연결은 아직 없다. fine-tuning 명령은 blocked scaffold다.
자동 온라인 학습·백그라운드 학습·원격 이벤트 업로드를 구현하지 않는다.

이벤트 수집의 범위와 보존 정책은 [로컬 이벤트](local-learning-events.md),
평가 파일 계약과 승격 기준은 [학습 파이프라인](learning-pipeline.md),
Laya 환경은 [로컬 provider](laya-local.md)에 정의한다.
실사용 정확도·지연·호스트 호출 비용 개선은 G3에서 별도 검증해야 한다.
