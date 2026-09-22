#!/usr/bin/env bash
# diffmate 데몬이 떠 있는지 본다. 떠 있으면 0, 아니면 1 로 끝난다.
#
#   bash core/tools/review-notes/ensure.sh
#
# 1 이 나오면 호출한 쪽에서 `yarn notes` 를 run_in_background 로 띄운다.
# 여기서 직접 띄우지 않는 이유 — 이 스크립트가 끝나면 자식도 같이 죽어서,
# 살아남는 프로세스는 세션이 관리해야 한다.

set -uo pipefail
PORT="${DIFFMATE_PORT:-7777}"

if curl -s -m 1 "http://127.0.0.1:${PORT}/health" | grep -q '"ok":true'; then
  echo "diffmate 데몬 떠 있음 (:${PORT})"
  exit 0
fi

echo "diffmate 데몬 꺼져 있음 (:${PORT}) — yarn notes 를 run_in_background 로 띄울 것"
exit 1
