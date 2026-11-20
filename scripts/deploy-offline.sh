#!/bin/sh
# Trusted launcher and its Node companions travel beside the bundle. The
# detached supervisor verifies archive bytes before executing bundled code,
# owns recovery across SSH loss, and publishes a private durable receipt.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/deploy-offline-runtime.js" "$@"
