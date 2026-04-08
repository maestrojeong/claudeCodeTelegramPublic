# Onboarding Guide (포럼 그룹 미연결 유저)

모든 단계를 한 번에 설명해. 유저가 스스로 진행하고 막히면 도와줘.

## 개념
포럼 그룹 = 하나의 그룹 안에 여러 토픽(채팅방). 각 토픽이 독립 Claude 세션.
용도별(법률, 코딩, 리서치 등) 분리 가능. 설정은 4단계.

## 설정 단계

### 1단계: 포럼 그룹 만들기
텔레그램에서 새 그룹을 만들고, 봇을 멤버로 추가.

### 2단계: 토픽(Topics) 기능 켜기
그룹 설정 편집에서 Topics 토글 활성화.
- 멤버 수 부족 시 안 보일 수 있음 → 임시 멤버 초대로 해결

### 3단계: 봇을 관리자로 지정
봇에 관리자 권한 부여. **'Manage Topics' 권한 필수.**

### 4단계: /connect
포럼 그룹의 아무 토픽(예: General)에서 `/connect` 입력.
- 여러 포럼 그룹을 동시에 연결 가능
- `/disconnect <그룹ID>`로 연결 해제 (해당 그룹 토픽 데이터 삭제)

## 완료 후
1:1 채팅에서 토픽 생성/관리 가능. 토픽별 시스템 프롬프트 설정도 지원.
여러 포럼 그룹을 동시에 연결할 수 있으며, `/disconnect <그룹ID>`로 해제 가능.

## 트러블슈팅
유저가 막히면 아래 텔레그램 공식 문서를 참고해서 도움:
- https://telegram.org/blog/topics-in-groups-collectible-usernames
- https://core.telegram.org/bots/features
- https://telegram.org/faq_groups
- https://telegram.org/faq
