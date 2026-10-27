# BusyBox and ash traps

Part of the osi-live-ops-runbook skill; read SKILL.md first.

## BusyBox / ash traps on the Pi

The Pi image runs BusyBox `ash`, not `bash`. These are field-verified operator
knowledge (label: operator-procedure, not independently re-derivable from this repo
alone):

- **No bash.** Don't use `[[ ]]`, arrays, `local` in places bash allows but POSIX
  doesn't, or bashisms in any one-liner you paste onto the Pi. Stick to POSIX `sh`/
  `ash` syntax, as `deploy.sh` itself does (`#!/bin/sh`, `set -eu`).
- **Case conversion:** use `tr 'abcdef' 'ABCDEF'`, not `tr '[:lower:]' '[:upper:]'`
  — the POSIX character-class form is unreliable on this image. This is also called
  out in `AGENTS.md` under "Conventions".
- **`localhost` resolves to IPv6 `::1` first** under the minimal `wget`/resolver on
  this image, which often has nothing listening on `::1`. Always target `127.0.0.1`
  explicitly in on-Pi curl/wget calls, including in the verification checklist
  above and in the reverse-tunnel deploy command.
- **The SSH "post-quantum" banner is harmless.** Every SSH connection to these
  gateways prints a post-quantum key exchange notice from the server side. Filter it
  out of scripted output rather than treating it as an error:
  ```bash
  ssh ... 2>&1 | grep -v -e 'post-quantum' -e 'store now'
  ```

---
