#!/usr/bin/env bash
# 데모 페이지의 액자 부분만 렌더해 README 스크린샷을 다시 만든다.
# 카드 구조나 문구를 고쳤으면 이걸 다시 돌린다.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "Chrome not found: $CHROME" >&2; exit 1; }

python3 - <<'PY'
import pathlib, re
s = pathlib.Path('index.html').read_text()
head = s.split('<body>')[0]
frame = re.search(r'<div class="browser">.*?\n</div>\n', s, re.S).group(0)
pathlib.Path('_shot.html').write_text(
    head + '<body style="padding:24px; background:var(--page-bg)">\n'
    '<div style="max-width:880px; margin:0 auto">\n' + frame + '</div>\n</body>\n</html>\n')
PY

mkdir -p docs/img
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=940,800 \
  --screenshot=docs/img/demo.png "file://$PWD/_shot.html" 2>/dev/null
rm -f _shot.html
echo "docs/img/demo.png"
