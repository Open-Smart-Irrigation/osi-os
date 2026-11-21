# Sourced by both emulator acceptance entry points.
browser_ready() {
  node -e '
    const { chromium } = require("playwright");
    require("node:fs").accessSync(
      process.env.CHROMIUM_PATH || chromium.executablePath(),
      require("node:fs").constants.X_OK
    );
  ' >/dev/null 2>&1
}

find_browser() {
  if ! browser_ready; then
    for modules in "$1" "$HOME"/.npm/_npx/*/node_modules; do
      if [[ -d "$modules/playwright" ]] && NODE_PATH="$modules" browser_ready; then
        export NODE_PATH="$modules"
        break
      fi
    done
  fi
  browser_ready || { echo "Install Playwright and Chromium or set NODE_PATH and CHROMIUM_PATH." >&2; exit 2; }
}
