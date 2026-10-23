#!/bin/bash
# Cloud-session setup: install deps and make the repo's Playwright use the
# browsers preinstalled in the image (downloading browsers isn't possible there).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

npm install --no-audit --no-fund

# The image ships Playwright browsers under /opt/pw-browsers at whatever
# revision it was built with; the pinned playwright package expects its own
# revision. Point it at a dir that maps the expected revision names onto the
# installed builds.
IMAGE_BROWSERS=/opt/pw-browsers
MANIFEST=node_modules/playwright-core/browsers.json
[ -d "$IMAGE_BROWSERS" ] && [ -f "$MANIFEST" ] || exit 0

SHIM="$CLAUDE_PROJECT_DIR/node_modules/.cache/pw-browsers"
mkdir -p "$SHIM"
for pair in chromium:chromium chromium-headless-shell:chromium_headless_shell ffmpeg:ffmpeg; do
  name=${pair%%:*}
  dir=${pair##*:}
  want=$(node -p "(require('./$MANIFEST').browsers.find(b => b.name === '$name') || {}).revision || ''")
  have=$(ls -d "$IMAGE_BROWSERS/$dir"-* 2>/dev/null | sort -V | tail -n 1 || true)
  if [ -n "$want" ] && [ -n "$have" ]; then
    ln -sfn "$have" "$SHIM/$dir-$want"
  fi
done

echo "export PLAYWRIGHT_BROWSERS_PATH=\"$SHIM\"" >> "$CLAUDE_ENV_FILE"
