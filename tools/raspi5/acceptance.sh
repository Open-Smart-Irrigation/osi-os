#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  exec python3 "$here/acceptance.py" --help
fi
gate=${OSI_HEAVY:-"$HOME/projects/osi-workstation-config/bin/osi-heavy"}
browser_ready() {
  node -e '
    const { chromium } = require("playwright");
    require("node:fs").accessSync(
      process.env.CHROMIUM_PATH || chromium.executablePath(),
      require("node:fs").constants.X_OK
    );
  ' >/dev/null 2>&1
}
if ! browser_ready; then
  for modules in "$here/../../web/react-gui/node_modules" "$HOME"/.npm/_npx/*/node_modules; do
    if [[ -d "$modules/playwright" ]] && NODE_PATH="$modules" browser_ready; then
      export NODE_PATH="$modules"
      break
    fi
  done
fi
browser_ready || { echo "Install Playwright and Chromium or set NODE_PATH and CHROMIUM_PATH." >&2; exit 2; }
exec "$gate" wait --contain --need-gib 10 --timeout 86400 --label 'OSI Pi 5 acceptance' -- python3 "$here/acceptance.py" "$@"
