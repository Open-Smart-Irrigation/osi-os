# Live gateway identity (Option C) — design spec

Status: ready for implementation. Execution target: Codex, task-by-task, per the companion plan `docs/superpowers/plans/2026-07-14-live-gateway-identity-plan.md`.

## Problem

A freshly flashed gateway cannot link to the cloud or sync until its gateway identity is `authoritative`, but the identity is captured once at Node-RED boot and frozen. On a first boot the LoRa concentrator (concentratord) is not ready yet, so the resolver falls back to a MAC-derived EUI marked `provisional`, and that snapshot is what every consumer reads for the life of the process.

Two edge gates enforce non-provisional identity, both reading the frozen `env.get('DEVICE_EUI_CONFIDENCE')`:

- Link is blocked in `al-link-validate` / `al-link-build-req` with "Gateway identity is not ready yet. Wait for ChirpStack gateway detection before linking."
- Sync is blocked in `requireStableGatewayIdentity()` (duplicated across `sync-bootstrap-build`, `sync-outbox-build`, `sync-pending-build`, `sync-force-build`) with the "…before syncing." variant.

Observed on the 192.168.8.180 bench Pi (2026-07-14): concentratord was enabled after first boot, the resolver run fresh returns `DEVICE_EUI=0016C001F116EBF2 / concentratord-runtime / authoritative`, yet UCI still held `88A29EFFFE8D8D6C / mac:eth0 / provisional` and Node-RED's environment still reported `provisional`. Linking stayed blocked across a reboot because the boot sequence re-froze the snapshot before concentratord bound. This is an image-level defect, not a per-device misconfiguration: nothing in the shipped image reconciles identity after concentratord becomes ready short of a manual Node-RED restart.

A second, independent defect surfaced during the same investigation: `chirpstack-bootstrap.js` never registers a gateway in ChirpStack for any device — it only logs the EUI, and `allow_unknown_gateways=true` has masked the gap for uplink traffic while `updateGatewayLocation` fails silently on the unregistered gateway. The gateway table is empty on every gateway.

## Goal and success criteria

A gateway resolves and maintains a correct identity as a live property of the running system, not a boot-time constant.

- A fresh flash with concentratord enabled detects and durably heals to `authoritative` identity within one provisional refresh interval of concentratord binding. The link/sync gates open after the 60 s warning and automatic Node-RED restart; no operator action or OS reboot is required.
- Identity stays correct through concentratord restarts, a swapped concentrator, and a demo→real transition, without a code change or a reflash.
- Every stable non-provisional EUI is registered as a ChirpStack gateway by an independent reconciliation loop, including gateways that were already authoritative before this feature shipped. This also unblocks the GPS location mirror.
- A concentrator-less demo/dev box degrades gracefully to permanent `provisional` without hot-polling or log spam, and the existing `link_gateway_device_eui` override takes effect live.
- Steady-state CPU cost is immeasurable; the aggressive provisional-phase cadence stays under 0.1% of one core.

## Non-goals (tracked separately, not in this work)

- The `/api/devices` 500-instead-of-401 regression (issue #9): the merged fix is ineffective at runtime because Node-RED's Catch node drops the thrown `statusCode`. Separate fix with a runtime test.
- The pipeline checks' SSH-banner filter being too narrow (false-fails four on-device checks on this gateway's OpenSSH banner). Separate one-line fix (`ssh -q -o LogLevel=ERROR`).
- The migration-preflight refactor: this design reuses `runGatewayMigrationPreflight` as-is and does not touch it. Slice 3 extracts only the duplicated restart-sentinel reader.

## Measured basis (kaba100, Pi 5, concentratord live)

Timings were taken on kaba100 because the 192.168.8.180 bench Pi was intermittently offline during measurement; kaba100 is the same Pi 5 hardware and image family, so CPU cost transfers. Re-measure on the target when stable (non-blocking; CPU cost will not differ).

| Operation | Per-call |
|---|---|
| Full `osi-gateway-identity.sh resolve` (concentratord answering) | 7.9 ms |
| `gateway-id` ZMQ probe | 2.7 ms |
| `uci -q get` | 0.5 ms |
| tmpfs small-file read | 0.4 ms |

The concentratord probe uses `zmq::poll(&mut items, 100)` — a hard 100 ms timeout then error exit (verified against the pinned `chirpstack-concentratord` v4.4.8 source), so it never blocks indefinitely when the socket exists but the daemon is dead. With no socket at all, a resolve is ~5–8 ms of UCI/sysfs reads. BusyBox on the image has no `timeout` applet — the daemon must not assume one; the probe self-bounds.

One resolve is ~8 ms CPU (worst ~108 ms wall, almost all of it poll-sleep). Function nodes must not shell out, and unserialized resolves during a concentratord restart give racy answers. A single serialized refresher owns resolution and persistence. Node-RED reads only the coordinator's sentinel and never runs or substitutes a live identity resolve.

## Architecture

```
concentratord ── ipc:///tmp/concentratord_command (gateway-id, 100 ms-bounded)
      ▲
      │ gateway_identity_resolve  (existing precedence chain, unchanged)
osi-identityd  (new procd daemon)  ── 10 s while provisional / 300 s steady
      │
      ├─ write ─────► /var/run/osi-gateway-identity.json
      │               (atomic tmp+mv; observability + registration input)
      │
      ├─ coordinate ─► /var/run/osi-identity-restart.json
      │                     │ readFileSync (tmpfs, ~µs)
      │                     ▼
      │        seven Node-RED link/sync consumers fail closed
      │        while continuing to use the boot environment
      │
      ├─ transition (non-provisional and EUI differs OR durable confidence is provisional):
      │    1. write a deadline-free `healing` sentinel
      │    2. heal: resolve → repair → resolve → persist
      │    3. validate the final EUI/confidence and durable UCI readback
      │    4. set restartAt to now + 60 s
      │    5. /etc/init.d/node-red restart; remove sentinel only on exit 0
      │
      └─ reconcile ─► chirpstack-register-gateway.js
                      (independent, idempotent, retried until ChirpStack is ready)
```

### Decision 1 — refresher is a procd daemon, not a Node-RED inject

`osi-identityd` is a new procd-supervised BusyBox-ash daemon that sources the existing `osi-gateway-identity.sh` and loops. The resolver is shell, function nodes must avoid `child_process`, and the actor that restarts Node-RED must run outside that process. ChirpStack registration also needs the same fresh source. procd respawns the daemon. If it is absent and no sentinel exists, Node-RED keeps today's boot-environment behavior; if a sentinel already exists, consumers remain fail-closed until the daemon recovers it. `node-red.init` keeps its resolve-at-start, and both callers use the shared heal/persist functions.

### Decision 2 — cache transport is hybrid: tmpfs JSON (live) + UCI (durable) + env (seed/fallback)

`/var/run/osi-gateway-identity.json` (tmpfs) is the daemon's live observation and registration surface: single writer, atomic same-filesystem `mv`, ~200 bytes. It survives a Node-RED restart, unlike `global` context. UCI stays the durable identity store and seeds `node-red.init` on each start. Node-RED link/sync consumers do not select an EUI from this cache; they keep the boot environment and read only the restart sentinel. Registration may use an unfresh non-provisional cache entry when phase is `active` or `restart_pending` because `ensureGateway` is idempotent, but it must not use `healing` or `provisional` state.

### Decision 3 — adaptive cadence: 10 s provisional (first 10 min), then 300 s

While `provisional`, resolve every 10 s so identity converges within ~10 s of concentratord binding. After 10 continuous provisional minutes, demote to 300 s permanently (demo give-up). The loop never stops, so a late HAT or config fix still self-heals within 5 minutes. Once non-provisional, resolve every 300 s. A one-second control tick remains separate from this cadence so restart requests and expired deadlines are handled promptly. Failed identity heals and failed ChirpStack registrations retry every 10 s without making sync ticks run the resolver.

### Decision 4 — transition detection includes confidence promotion and validates the healed result

At each resolution tick the daemon compares the fresh result with the durable UCI EUI and confidence. It begins a transition when the fresh result is non-provisional and either the EUI differs or durable confidence is empty or `provisional`. The confidence branch covers a linked override or concentrator result whose numeric EUI matches the provisional fallback. Healthy reboots and concentratord flaps do not transition because the resolver falls through to the same persisted EUI with `persisted` confidence.

The daemon writes a deadline-free `healing` sentinel before the first UCI mutation, then calls the shared `heal` operation in the required order: `resolve → repair → resolve → persist`. A zero exit alone is insufficient. Before scheduling a restart, the daemon requires the final helper globals to contain a normalized non-provisional EUI and requires the durable UCI readback to match that final EUI and confidence. If the final EUI changed to another non-provisional value during healing, the daemon atomically retargets the sentinel to that final value. A provisional result or readback mismatch leaves the sentinel in `healing`, creates no deadline, and retries after 10 s.

An existing `healing` sentinel drives recovery even when UCI already matches the target. This closes the crash window after persistence but before deadline creation. An existing `restart_pending` sentinel retains its original deadline; when that deadline is already due, the next control tick attempts the restart immediately. `runGatewayMigrationPreflight` remains in Node-RED and is not called or edited by the daemon.

### Decision 5 — Node-RED keeps one boot identity and fails closed on the restart sentinel

Seven nodes read only `/var/run/osi-identity-restart.json`: `sync-bootstrap-build`, `sync-outbox-build`, `sync-pending-build`, `sync-force-build`, `command-ack-build-batch`, `sync-state-build`, and `al-link-build-req`. They never substitute the cache candidate for `env.get('DEVICE_EUI*')`. A present valid sentinel blocks identity-sensitive work; a present malformed or unreadable sentinel also blocks and emits `node.warn`. A missing sentinel preserves today's boot-environment behavior.

`al-link-validate` remains byte-identical. On a fresh-flash transition it may reject the provisional boot environment before `al-link-build-req` runs; on a live EUI replacement the build node catches the sentinel after validation. Both paths prevent the cloud request. Requests or sync work already past their sentinel check may finish under the old boot identity. This is accepted because every coupled surface stays on that same generation until restart, and the existing retry, deduplication, and migration-preflight paths handle interrupted delivery.

Heartbeat, telemetry, local writers, MQTT credentials/client ID, and `sync-init-fn` also stay on the boot environment. The single Node-RED restart switches the process environment, broker identity, credentials, trigger EUI, link requests, and sync requests together. `sync-init-fn` and every `runGatewayMigrationPreflight` body remain untouched.

### Decision 6 — demo/no-concentrator mode degrades gracefully

With no concentratord socket, each resolve is ~5–8 ms (the binary is never invoked). After 10 provisional minutes the cadence relaxes to 300 s forever; no transition fires, so there are no registration attempts, restarts, or log spam, and the gates keep their existing behavior. The `link_gateway_device_eui` override propagates without a manual restart: the daemon detects the confidence/EUI change, heals it, warns for 60 s, and opens the gates after the coordinated Node-RED restart.

## Auto-restart UX (operator decision: auto-restart and heal, 60 s warning)

The heal is a Node-RED restart, not an OS reboot. `node-red.init start_service()` re-derives the whole identity-coupled surface on every start — the `DEVICE_EUI*` env, the broker `clientid=device_<EUI>`, `flows_cred.json = {user:<EUI>, …}`, and (via `sync-init-fn` running at flow deploy) the `trg_sync_devices_defaults_ai` trigger EUI. concentratord, mosquitto, and ChirpStack keep running; only Node-RED bounces (~10–15 s). The identity restart must not reuse the OS-reboot route `/api/system/reboot` that the GUI's `SystemPanel` button calls — it is the daemon's own `/etc/init.d/node-red restart`.

The daemon owns the timer and restart; there is no daemon-to-Node-RED HTTP dependency. It writes `/var/run/osi-identity-restart.json` in `healing` phase before mutation, adds the absolute 60 s deadline only after post-heal validation, and checks the deadline on its one-second control tick. procd respawn resumes the same sentinel. An overdue deadline causes an immediate restart attempt, and a failed restart keeps the sentinel, moves the deadline 30 s forward, and retries. The daemon deletes the sentinel only after `/etc/init.d/node-red restart` exits zero.

Bootstrap, account link, and account unlink no longer start their own background restarts. They place unique request files under `/var/run/osi-node-red-restart-requests/`; the daemon consumes them within one control tick. The link and unlink publishers fail closed: a missing filesystem global, an invalid or overlong message ID, or any directory/write/rename failure sets a red node status and returns HTTP 503 through an error-only output. That output does not clear the link-flow state or trigger bootstrap. Their success output retains the existing response, state-clear, and bootstrap fan-out. Request filenames use a deterministic, path-confined encoding of a bounded message ID, and publication uses a separate unique mode-`0600` temporary file plus an atomic rename. A gateway identity transition has priority and always receives a fresh 60 s warning from detection time. Generic requests keep the earliest deadline and cannot shorten an identity transition.

The already-polled, unauthenticated `/api/system/stats` (`sys-stats-fn`, which already reads `/var/run` files via `global.get('fs')`) surfaces `restartPending: {restartAt, reason} | null`. Unauthenticated is correct because the banner must show before login on a fresh flash. Only `restartAt` and `reason` are exposed; EUIs remain private. The `healing` phase has no deadline and therefore no countdown. Once scheduled, the GUI renders a local per-second countdown from the absolute timestamp. It keeps the in-progress message at zero through transient API failures and clears after a successful response reports no pending restart. There is no cancel action.

## Risks and mitigations

- Identity change on a live gateway with synced data: the unchanged existing machinery is the mitigation. `requireStableGatewayIdentity` and `runGatewayMigrationPreflight` transactionally (`BEGIN IMMEDIATE`) rewrite zones/devices/gateway_locations/outbox and pause sync via `gatewayMigrationPendingBootstrap` until re-baseline. Cloud history under the old EUI remains stranded until re-link, and the offline verifier `bcrypt(password::DEVICE_EUI)` breaks. The transition restart moves MQTT to the new EUI immediately, but the existing password may not authenticate until re-link issues matching credentials.
- Migration flags lost on a restart mid-migration (`sync_state` is memory-backed): a pre-existing gap (the link restart can hit it today), not widened — after the restart the preflight rescans the DB, already-rewritten rows yield a clean state, and the only loss is the `previousGatewayDeviceEuis` hint. The fresh-flash path is moot: unlinked gateways skip the preflight (`getCloudSyncTarget()` null-returns first) and linking happens after the transition restart.
- Concentratord flapping: damped by precedence (`read_persisted`, never provisional) so the gates stay open and no transition fires; probe worst case is the source-verified 100 ms.
- Restart loops: a transition requires a non-provisional EUI change or durable provisional confidence. The target-keyed sentinel prevents duplicate scheduling while allowing a second real EUI transition in the same boot.
- Daemon death during healing: the sentinel, rather than the persisted-vs-resolved comparison alone, resumes the incomplete transition. Post-heal validation prevents a provisional fallback from becoming active.
- Cache or sentinel damage: cache loss does not change Node-RED's boot identity. A missing sentinel preserves current behavior; an existing unreadable sentinel fails closed and warns. Atomic same-directory renames prevent torn writes during normal operation.

## Slices

- Slice 1 — the liveness fix: `osi-identityd`, the tmpfs cache and restart coordinator, the identity-helper `heal` subcommand, and fail-closed sentinel checks in seven Node-RED nodes. Consumers retain the boot identity until the warned restart.
- Slice 1b — the restart-warning UX: the daemon's restart-file write, the `sys-stats-fn` `restartPending` field, and the React countdown banner with i18n. Lands in the same change set as Slice 1.
- Slice 2 — ChirpStack gateway registration: `ensureGateway()` in `osi-chirpstack-helper` and the idempotent `chirpstack-register-gateway.js`, called by an independent reconciliation loop for `active` or `restart_pending` non-provisional identity.
- Slice 3 — follow-up DRY: extract only the duplicated restart-sentinel reader into an npm-local helper. It does not move identity selection, DB access, `runGatewayMigrationPreflight`, or schema code. Behavior-preserving; separate PR.

Recommended order: 1+1b first as the shippable out-of-box fix, 2 close behind (real new capability), 3 as a later cleanup.
