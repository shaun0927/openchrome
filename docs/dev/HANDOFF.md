# 구현 인계

추적 이슈: https://github.com/shaun0927/openchrome/issues/1666

제품 반영 범위는 opt-in 로컬 기록과 dataset/registry 관리 기반이다.
Laya 모델을 실행하는 평가 worker와 실제 브라우저 실행 권한은 분리돼 있다.
이 변경의 merge는 npm 게시·재설치·모델 학습 완료를 의미하지 않는다.

남은 실험 과제:

- 독립 host/user 라벨과 충분한 클래스별 holdout 확보.
- 실제 Laya 가중치·장치·버전별 평가와 지연 측정.
- task별 임계값 승인과 G3 host/approval 기록.
- adapter 로딩과 보수적 reviewer runtime 연결은 별도 설계·검증.
- 학습 실행기는 별도 로컬 환경에서 명시적으로 운영.

원래 로컬 변경이 있던 작업 트리는 복구 가능한 원본으로 보존했다.
과거 artifacts의 통과 문구를 현재 SHA의 검증 근거로 재사용하지 않는다.
기준 문서는 LEARNING_ARCHITECTURE.md와 RUNBOOK.md이며 생성된 과거 실험 보고서는 참고 자료다.
