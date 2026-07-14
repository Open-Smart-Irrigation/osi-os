---
name: osi-verification-commands
description: Use when selecting OSI OS verification commands, writing execution-report.md evidence, checking pass signals, or deciding whether a red local/base gate should stop Forge or agent execution.
---

# OSI Verification Commands

## Overview

Paste real command output and exit status into `execution-report.md`. Do not
claim a gate passed from memory, from a piped command's last process, or from a
truncated `tail` output.

Verified commands and pass signals come from scripts and workflow files in this
repo (`scripts/`, `.github/workflows/`) plus `AGENTS.md`.

## Rules

- Run commands from the repo root unless the row says otherwise.
- Check the command's own exit code directly. Never prove success with
  `command | tail`, `grep OK`, or another pipe unless `set -o pipefail` and the
  original status are explicitly captured.
- Paste enough output into `execution-report.md` to show the pass signal and
  any relevant warning context.
- If a required verifier is red on the branch base, stop and report
  `red-on-base`; do not bury the baseline failure inside your patch.
- If a verifier is not relevant to the changed surface, say why instead of
  running broad, expensive gates as decoration.

## Command Table

| Surface | Command | Pass signal |
|---|---|---|
| Full sync/flow contract | `node scripts/verify-sync-flow.js` | Prints `Sync flow verification passed` in its own section and exits 0; it also chains profile parity, so a healthy full run ends with `All parity checks passed.` |
| Profile payload parity | `node scripts/verify-profile-parity.js` | Ends `All parity checks passed.`, exit 0. |
| MQTT IN topic compliance | `scripts/check-mqtt-topics.sh` | `OK:` lines for checked flow copies, exit 0. |
| Flow wiring guards | `node scripts/test-flows-wiring.js` | Ends `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`, exit 0. |
| Silent catch ratchet | `node scripts/verify-no-new-silent-catch.js` | Exit 0. Any new or worsened empty catch in maintained flow nodes is a stop. |
| Stray DDL ratchet | `node scripts/verify-no-stray-ddl.js` | Exit 0. A new DDL marker in `flows.json` or `deploy.sh` must be intentional and reviewed. |
| Migration file structure | `node scripts/verify-migrations.js` | Exit 0. Do not require a specific success string; current versions may print an OK line with migration/checksum details. |
| Seed replay parity | `node scripts/verify-seed-replay.js` | `verify-seed-replay: OK`, exit 0. |
| Runtime schema parity | `node scripts/verify-runtime-schema-parity.js` | Exit 0; current healthy output includes an OK summary for flow devices CHECK and trigger parity. |
| Bundled DB schema consistency | `node scripts/verify-db-schema-consistency.js` | Ends `DB schema consistency verification passed`, exit 0. |
| Devices CHECK rebuild fence | `node scripts/verify-devices-rebuild-fence.js` | `verify-devices-rebuild-fence: OK (<n> flows)`, exit 0. Required when touching `sync-init-fn` devices-CHECK logic. |
| Devices CHECK rebuild rehearsal | `node --test scripts/rehearse-devices-rebuild.test.js` | Node test exit 0. Required with `verify-devices-rebuild-fence.js` for `sync-init-fn` devices-CHECK touches. |
| Boot-DDL interpolation | `node scripts/verify-boot-ddl-interpolation.js` | Ends `verify-boot-ddl-interpolation: OK`, exit 0. Required when touching `sync-init-fn` DDL strings or seed triggers. |
| Trigger-body parity | `node scripts/verify-trigger-body-parity.js` | Ends `verify-trigger-body-parity: OK`, exit 0. Required when touching any trigger in seed-blank.sql or the `sync-init-fn` rewrites. |
| Function-node parse | `node scripts/verify-flows-fn-parse.js` | Ends `verify-flows-fn-parse: OK`, exit 0. Required for any flows.json function-node edit. |
| STREGA Gen1 decoder | `node scripts/verify-strega-gen1.js` | Exit 0. |
| Aqua-Scope LoRain decoder | `node scripts/verify-lorain-codec.js` | Exit 0. |
| SENSECAP S2120 decoder | `node scripts/verify-s2120-codec.js` | Exit 0. |
| Codec robustness | `node scripts/verify-codec-robustness.js` | Exit 0. |
| Communication contract | `node scripts/verify-communication-contract.js` | Exit 0. |
| Gateway health persistence | `node --test scripts/test-gateway-health-persistence.js` | Node test exit 0. |
| Flows size ratchet | `node scripts/verify-flows-size-ratchet.js` | Exit 0. Fails if any existing node grew, a new node exceeds 4 KB, or total embedded JS increased. |
| Helper registration | `node scripts/verify-helper-registration.js` | Exit 0. Verifies osi-lib NAME_TO_PATH registry, loader test, and deploy.sh coverage match. |
| Bare require scan | `node scripts/flows-bare-require-scan.js` | Exit 0. Fails if any function node uses bare `require()` instead of `osiLib.require()`. |
| Channel manifest parity | `node scripts/verify-channel-manifest-parity.js` | Exit 0. GUI and edge manifest byte-identical. |
| Command safety | `node scripts/verify-command-safety.js` | Exit 0. Actuator duration-bound + registry parity assertions. |
| Heartbeat health | `node scripts/verify-heartbeat-health.js` | Exit 0. |
| Dendro contract mirror | `node scripts/verify-dendro-contract-mirror.js` | Exit 0. |
| Contract schemas | `node scripts/test-contract-schemas.js` | Exit 0. |
| Device integration round-trip | `node scripts/verify-device-integration.js` | Exit 0. Full codec→normalize→write round trip for all registered devices. |
| LSN50/Chameleon codec | `node scripts/verify-lsn50-chameleon-codec.js` | Exit 0. |
| GUI typecheck | `cd web/react-gui && npm run typecheck` | npm exits 0. CI-gated; `vite build` does not typecheck. |
| GUI unit tests | `cd web/react-gui && npm run test:unit` | npm exits 0. |
| GUI build | `cd web/react-gui && npm run build` | npm exits 0. |
| Whitespace/diff sanity | `git diff --check` | No output, exit 0. |

## Surface Selection

| Changed surface | Minimum local evidence |
|---|---|
| `flows.json` function, route, inject, MQTT, or wiring | Roundtrip guard, `verify-no-new-silent-catch.js`, `test-flows-wiring.js`, `verify-flows-size-ratchet.js`, `flows-bare-require-scan.js`, `verify-flows-fn-parse.js`, `check-mqtt-topics.sh` if MQTT touched, `verify-no-stray-ddl.js` if DDL-like text changed, `verify-sync-flow.js`. |
| Edge schema, seed, bundled DBs, migrations, or `deploy.sh` schema repair | `verify-migrations.js`, `verify-seed-replay.js`, `verify-runtime-schema-parity.js`, `verify-db-schema-consistency.js`, `verify-no-stray-ddl.js`, `verify-profile-parity.js`, `verify-boot-ddl-interpolation.js`, `verify-trigger-body-parity.js`. |
| `sync-init-fn` devices-CHECK/rebuild logic | Edge schema set plus `verify-devices-rebuild-fence.js` and `node --test scripts/rehearse-devices-rebuild.test.js`. |
| Device decoder or payload semantics | The device-specific decoder verifier plus `verify-codec-robustness.js`; add `verify-sync-flow.js` if ingest flow or DB writes changed. |
| React GUI | `npm run test:unit` and `npm run build` from `web/react-gui`; add contract/edge verifiers if GUI semantics depend on changed edge fields. |
| Sync contract docs or payload schemas | `verify-communication-contract.js` plus the edge/server tests named by the contract change. |
| Server/backend companion work | Use the sister `osi-server` repo gates for backend changes. OSI OS edge verifiers do not prove cloud Java/Postgres behavior. |

## Common Mistakes

- Requiring `verify-migrations.js` to print an exact OK string; use exit 0
  because the script's summary can include current migration and checksum
  details.
- Treating `verify-sync-flow.js | tail -1` as proof. The pipe can hide the real
  exit code and the final line can come from chained profile parity.
- Ignoring a red verifier because it was "red before." Red-on-base is a
  stop-and-report condition unless the task explicitly scopes baseline repair.
- Omitting `verify-s2120-codec.js` or `verify-codec-robustness.js` for decoder
  work because `verify-sync-flow.js` happened to pass.
