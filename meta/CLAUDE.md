
## 디렉토리 구조
```
user_{userId}/
├── CLAUDE.md                    # 이 문서 (프로젝트 컨텍스트)
├── workspace/                   # 주요 작업 공간
│   └── tmp/                     # 임시 다운로드/캐시
├── tmp/                         # 임시 파일 (정기 삭제 대상)
└── .claude/
    └── agents/                  # 자율 에이전트 정의
```

## 세션 간 통신

다른 세션(토픽)에 정보를 물어보거나 전달할 때 MCP 도구를 사용한다.

- `mcp__session-comm__list_sessions` — 현재 사용 가능한 세션(토픽) 목록 조회
- `mcp__session-comm__ask_session` — 다른 세션에 질문 (응답은 나중에 자동 주입)
  - `to`: 토픽 이름 (예: "law-test", "youtube", "coding")
  - `message`: 질문 또는 전달할 내용
  - 응답을 기다릴 필요 없이 현재 작업을 계속할 때 사용
  - 결과는 communicate 토픽에 자동 기록됨

- `mcp__session-comm__command_session` — 다른 세션에 단방향 명령 전송 (응답 없음)
  - `to`: 대상 토픽 이름
  - `message`: 전달할 명령 내용
  - 명령은 대상 토픽에 `[from: 세션명]` 형태로 메시지로 표시되고 Claude가 처리
  - 명령 받은 세션은 다시 `command_session`을 사용할 수 없음 (무한루프 방지)

- `mcp__session-comm__ask_cron` — 이 토픽의 크론 세션에 질문 (크론이 수집한 데이터 조회)
  - `message`: 질문 내용
  - 예: 뉴스, 주식, 모니터링 결과 등 크론이 쌓은 데이터 확인 시 사용

## 오케스트레이션 (멀티세션 협업)

여러 세션이 **협력**해서 복잡한 작업을 처리해야 할 때 사용. 유저가 "orchestrate", "조율", "여러 세션 합쳐서", "같이 작업해서" 같은 요청을 하면 이 방식을 사용한다.

- `mcp__session-comm__orchestrate` — 내 세션을 포크해서 복잡한 멀티세션 작업 실행
  - `task`: 수행할 작업 설명 (어느 세션에 무엇을 물어볼지 포함)
  - 내부에서 `delegate_to_session`으로 다른 세션들에 작업을 위임하고 결과를 종합해서 반환
  - 결과는 이 세션으로 직접 돌아옴

- `mcp__session-comm__delegate_to_session` — **orchestrate 내부에서만 사용**. 다른 세션에 작업을 위임하고 결과를 동기적으로 수집
  - `to`: 대상 세션 이름
  - `message`: 보낼 메시지
  - `ask_session`과 달리 응답을 즉시 반환받음

### orchestrate 사용 패턴

```
# 유저: "coding이랑 research 세션 조율해서 결과 줘"
→ orchestrate(task="coding 세션에 X를 물어보고, research 세션에 Y를 조회해서 결과를 종합해줘")

# orchestrate 내부에서:
→ delegate_to_session(to="coding", message="X")   # 결과 즉시 반환
→ delegate_to_session(to="research", message="Y") # 결과 즉시 반환
→ 두 결과 종합해서 반환
```

- `ask_session`은 단순 질의용. 여러 세션이 협력해서 작업을 나눠야 하면 `orchestrate` + `delegate_to_session` 사용
- 최대 depth 3, 순환 호출 불가
- 진행 상황(tool use, 중간 과정)은 이 토픽에 실시간으로 표시됨

## 핵심 규칙

### 파일 전송
- `send_file` MCP 도구 사용
- 응답에 `[FILE:/absolute/path]` 태그 포함 필수
- 파일명은 ASCII만 (한글 금지)
- **txt 파일 전송 지양** → PDF로 변환 후 전송

### 정기 작업 (Cron)
- **pm2 + uv 기반 cron**: 세션과 독립적으로 영속 실행
- 스크립트 위치: `~/claudeCodeTelegram/cron/`
- 실행 cwd: 프로젝트 루트 (`PROJECT_ROOT`)
- MCP 도구:
  - `mcp__cron-manager__cron_create` — cron job 생성 (name, script, cron, topic)
  - `mcp__cron-manager__cron_list` — 현재 cron job 목록
  - `mcp__cron-manager__cron_delete` — cron job 삭제
  - `mcp__cron-manager__cron_logs` — cron job 로그 조회
- 스크립트의 stdout → `claude -p` 프롬프트로 사용, 결과는 topic에 전송
- 활성 쿼리가 있으면 자동 대기 후 실행 (세션 충돌 방지)
- 의존성 추가: `cd ~/claudeCodeTelegram/cron && uv add {패키지}`
- **내장 `/loop`, `CronCreate`는 사용하지 않는다** (세션 끊기면 소멸)

### 작업 디렉토리 (cwd)
토픽 생성 시 `cwd` 파라미터로 작업 디렉토리 지정 가능. 미지정 시 ~/.

### 폴더 정리 규칙
- `tmp/`: 일회성 파일
- 루트에 파일 흩뿌리지 않기 → 용도별 폴더에 정리
