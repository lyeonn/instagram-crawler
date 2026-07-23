#!/usr/bin/env bash
# 인스타 제목 재분석 올인원 실행기 (사이드카+Nest 자동 기동 → 분석 → 로그 실시간)
#
# 사용법 (프로젝트 폴더에서):
#   bash scripts/run-analyze.sh          # 빈 행(새 글)만 채우기 — 기존 제목 보존
#   bash scripts/run-analyze.sh force    # 전체 다시 — 기존 제목까지 덮어씀
#   VL_MODEL=mlx-community/Qwen3-VL-8B-Instruct-8bit bash scripts/run-analyze.sh   # 모델 바꿔서
#
# 이미 떠 있는 서버는 재사용하고, 없으면 자동으로 띄운다. 로그는 /tmp/veasly-vl/ 에 쌓임.

cd "$(dirname "$0")/.." || exit 1              # 프로젝트 루트로 이동
VL_MODEL="${VL_MODEL:-lmstudio-community/Qwen3.5-9B-MLX-4bit}"
LIMIT="${LIMIT:-80}"
LOGDIR="/tmp/veasly-vl"; mkdir -p "$LOGDIR"
FORCE=""; [ "$1" = "force" ] && FORCE="&force=1"

sidecar_ok() { curl -s -m3 http://127.0.0.1:8088/health 2>/dev/null | grep -q '"ok":true'; }
nest_ok()    { [ "$(curl -s -m3 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3100/instagram/media?limit=1' 2>/dev/null)" = 200 ]; }

# 1) 사이드카(VLM)
if sidecar_ok; then
  echo "✓ 사이드카 이미 실행 중"
else
  echo "▶ 사이드카 시작 ($VL_MODEL) … 모델 로딩에 30초~2분"
  VL_MODEL="$VL_MODEL" ../.venv-vl/bin/python scripts/vl_server.py > "$LOGDIR/sidecar.log" 2>&1 &
  until sidecar_ok; do
    grep -qiE "Traceback|Error" "$LOGDIR/sidecar.log" && { echo "✗ 사이드카 기동 실패:"; tail -5 "$LOGDIR/sidecar.log"; exit 1; }
    sleep 3
  done
  echo "✓ 사이드카 준비됨"
fi

# 2) Nest 서버
if nest_ok; then
  echo "✓ Nest 이미 실행 중"
else
  echo "▶ Nest 시작 …"
  npm run start:prod > "$LOGDIR/nest.log" 2>&1 &
  until nest_ok; do sleep 2; done
  echo "✓ Nest 준비됨"
fi

# 3) 재분석 실행 (사이드카 로그를 실시간으로 흘려보면서)
MODE=$([ -n "$FORCE" ] && echo "전체 재분석(force)" || echo "빈 행만 채우기")
echo "▶ ${MODE} 시작 — 게시물 최근 ${LIMIT}개.  진행 로그:"
echo "  ------------------------------------------------"
# 사이드카 로그가 이 경로에 있으면 실시간으로 흘려보냄. (이미 다른 방식으로 떠 있던
# 사이드카면 로그 파일이 없을 수 있는데, 그땐 tail 생략하고 완료까지 대기만.)
TAILPID=""
if [ -f "$LOGDIR/sidecar.log" ]; then
  tail -n0 -f "$LOGDIR/sidecar.log" | sed 's/^ *//' &
  TAILPID=$!
else
  echo "  (이미 실행 중이던 사이드카라 이 창엔 실시간 로그가 안 떠요 — 완료까지 대기 중…)"
fi
RESULT=$(curl -s -m 5400 "http://127.0.0.1:3100/instagram/analyze-titles?limit=${LIMIT}${FORCE}")
sleep 1; [ -n "$TAILPID" ] && kill "$TAILPID" 2>/dev/null
echo "  ------------------------------------------------"
echo "✓ 완료: $RESULT"
