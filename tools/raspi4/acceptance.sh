#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
    exec python3 -B "$here/pi4.py" --help
fi
if [[ -n ${OSI_HEAVY_HOLDER:-} ]]; then
    echo 'acceptance.sh queues its own osi-heavy slot. Invoke it outside the current holder.' >&2
    exit 2
fi
gate=${OSI_HEAVY:-osi-heavy}
gate_args=(wait --contain --need-gib 10 --timeout "${OSI_HEAVY_WAIT_SECONDS:-86400}" --label 'OSI Pi 4 acceptance')
for arg in "$@"; do
    case "$arg" in
        --flows-power-cut-only|--upgrade-boot-safety-only)
            exec "$gate" "${gate_args[@]}" -- timeout --kill-after=30s 4h python3 -B "$here/pi4.py" "$@"
            ;;
    esac
done
source "$here/../raspi5/find-browser.sh"
find_browser "$here/../../web/react-gui/node_modules"
exec "$gate" "${gate_args[@]}" -- timeout --kill-after=30s 4h python3 -B "$here/pi4.py" "$@"
