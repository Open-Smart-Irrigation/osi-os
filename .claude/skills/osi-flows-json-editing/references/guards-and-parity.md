# Guards and profile parity

Part of the osi-flows-json-editing skill; read SKILL.md first.

## Guard tests: `scripts/test-flows-wiring.js`

Run with plain `node scripts/test-flows-wiring.js` (not `node --test` — the
file is a plain script with hand-rolled assertions, not a `node:test` suite).
It pins these wiring and function-node contracts against the canonical
(bcm2712) `flows.json` only:

1. **STREGA actuation wiring** (labelled WS1, tags C5/H2/L1/M8) — exact
   `wires` arrays for specific node ids (e.g. `5974306566e99a92` must wire to
   exactly `072f29aa8760340a` and `write-strega-expectation`, and not directly
   to Build STREGA downlink), a required string
   (`STALE_OPEN_OBSERVED`) inside `strega-reconciliation-monitor`'s `func`,
   an absence check (must NOT contain `flow.get('command_types') || {}`), and
   node-existence checks for the today-liters HTTP trio.
2. **Field request intake + status apply wiring** — required HTTP routes,
   router `osiDb` binding/close behavior, contact-email persistence, pending
   command split output count, and status ACK queue wiring.
3. **Settings module gates** — bulk schedule-disable endpoint existence, bearer
   auth, scoped schedule update, response shape, and no valve/downlink mutation.
4. **`osiDb.Database` close audit** (WS2/WS3) — described above.
5. **Function-node `libs` declaration audit** — described above.
6. **Misc WS2/WS3 wiring invariants** — a handful of `node.id === '...'` checks
   for specific required substrings in specific nodes (gateway migration
   preflight's parameterized `q`/`run` helpers, `sync-force-build`'s timeout
   guard, `command-ack-build-batch`'s bootstrap gate, `s2120-zones-put-auth-fn`'s
   zone-id validation).

On failure it prints one `FAIL: N flow wiring regression(s):` line followed by
a bulleted list, then `process.exit(1)`; on success, it prints `OK` lines for
the asserted groups plus a final `PASS: STREGA wiring + osiDb close + WS2/WS3
wiring guards all passed`.

**When you intend a wiring change that this file pins, update the pin in the
same commit, with a commit message explaining why the wiring changed.** A
guard test that silently gets "fixed" to match new behavior stops being a
guard.

## Profile parity

`bcm2712` is canonical; `bcm2709` must mirror it byte-for-byte. Either write
your edit script to update both paths (as in the skeleton above) or mutate
the canonical file then `cp` it over the mirror — do not hand-edit the
mirror separately, and do not let the two diverge even by a trailing newline.

Enforced by `node scripts/verify-profile-parity.js`, which is chained from
`node scripts/verify-sync-flow.js` (it runs as the final step, via
`spawnSync`). Output shape:

```
=== conf/full_raspberrypi_bcm27xx_bcm2709 ===
OK:   files/etc/board.d/02_network
... (one OK: line per CANONICAL_PAYLOAD entry, one absent: line per FORBIDDEN_IN_MIRROR entry; the lists live in scripts/verify-profile-parity.js)

All parity checks passed.
```

On a mismatch it instead prints `FAIL: files/usr/share/flows.json: content
differs between conf/full_raspberrypi_bcm27xx_bcm2712 and
conf/full_raspberrypi_bcm27xx_bcm2709` and exits non-zero.

## MQTT IN topic rule

Every `mqtt in` node in `flows.json` must subscribe to the literal topic
`application/+/device/+/event/up`. Every `mqtt in` node in the canonical file uses exactly that topic string; list
them with `grep -c '"type": "mqtt in"' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
and let `scripts/check-mqtt-topics.sh` do the checking rather than trusting a count written here. ChirpStack generates a fresh
per-installation application UUID at bootstrap; a topic hardcoded to one
gateway's UUID (e.g. `application/<uuid>/device/+/event/up`) will silently
never match on any other gateway — no error, just zero uplinks. Device-type
discrimination happens downstream of the MQTT IN node via
`CHIRPSTACK_PROFILE_*` env vars and `deviceProfileName` fallback matching
(semantics documented in `osi-config-and-flags`, not here).

Enforced by `scripts/check-mqtt-topics.sh`, which checks all three flow
copies (bcm2712, bcm2709, and a legacy bcm2708 path) for both a UUID-shaped
regex in any MQTT IN topic and an exact-string match against the expected
topic. Expected output shape:

```
OK: conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
OK: conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
OK: conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
```
exit 0.
