# Cron Jobs

pm2 + uv로 관리되는 Python cron job 디렉토리.

## 구조

```
cron/
├── pyproject.toml      # uv 프로젝트 설정 (의존성 관리)
├── .python-version     # Python 버전
├── README.md
└── *.py                # cron job 스크립트들
```

## 실행 방식

모든 스크립트는 pm2가 `uv run`으로 실행:

```bash
pm2 start "uv run cron/example.py --arg1 value" --name "cron-{userId}-{name}" --cron "0 9 * * *"
```

- pm2의 `--cron` 옵션: cron 표현식에 맞춰 프로세스를 (재)시작
- 스크립트가 종료되면 다음 cron 시점에 다시 실행
- 스크립트가 계속 실행되면 pm2가 alive 유지

## MCP 도구

Claude 세션에서 사용 가능한 도구:

- `cron_create(name, script, cron_expression, args?)` - cron job 생성
- `cron_list()` - 현재 cron job 목록
- `cron_delete(name)` - cron job 삭제
- `cron_logs(name, lines?)` - cron job 로그 조회

## 의존성 추가

```bash
cd cron/
uv add requests  # 예시
```

## pm2 명령어 (수동)

```bash
pm2 list                          # 전체 목록
pm2 logs cron-{userId}-{name}     # 로그 보기
pm2 delete cron-{userId}-{name}   # 삭제
pm2 restart cron-{userId}-{name}  # 재시작
```
