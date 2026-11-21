#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  exec python3 "$here/acceptance.py" --help
fi
if [[ -n ${OSI_HEAVY_HOLDER:-} ]]; then
  echo 'acceptance.sh queues its own osi-heavy slot. Invoke it outside the current holder.' >&2
  exit 2
fi
gate=${OSI_HEAVY:-"$HOME/projects/osi-workstation-config/bin/osi-heavy"}
gate_args=(wait --contain --need-gib 10 --timeout 86400 --label 'OSI Pi 5 acceptance')
for arg in "$@"; do
  case "$arg" in
    --flows-power-cut-only|--upgrade-boot-safety-only|--customer-fixture-only)
      exec "$gate" "${gate_args[@]}" -- python3 "$here/acceptance.py" "$@"
      ;;
  esac
done
source "$here/find-browser.sh"
find_browser "$here/../../web/react-gui/node_modules"
exec "$gate" "${gate_args[@]}" -- python3 "$here/acceptance.py" "$@"
