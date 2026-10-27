# Adding a config flag and re-verifying

Part of the osi-config-and-flags skill; read SKILL.md first.

## 8. Checklist: adding a new config flag

1. Decide the layer: durable per-installation identity/secret → UCI
   `osi-server.cloud.*` (add to `96_osi_server_config` with a safe default);
   ChirpStack-object-derived → follow the `chirpstack-bootstrap.js` pattern
   (env file + `toUciCloudKey` mapping); pure feature toggle with no
   per-install variance → flows.json constant (section 7 pattern).
2. If UCI: add the key with its default to
   `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config`
   inside the `uci -q batch` block.
3. Add the read path: `node-red.init`'s `start_service()` (export as
   `procd_set_param env`), and/or `chirpstack-bootstrap.js`'s `CFG` object if
   it's bootstrap-time-only.
4. If flows.json needs to read it, use `env.get('YOUR_KEY')` inside the
   relevant function node — follow `osi-flows-json-editing` for the mechanics
   of adding/wiring nodes.
5. **Mirror to bcm2709 byte-for-byte.** Any change under
   `conf/full_raspberrypi_bcm27xx_bcm2712/files/` (including
   `96_osi_server_config`, `osi-gateway-identity.sh`) must be propagated
   identically to `conf/full_raspberrypi_bcm27xx_bcm2709/files/` — the
   *contents* of `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`
   and `node-red.init` are shared (not per-profile), so those two files do not
   need mirroring, only the `conf/full_raspberrypi_bcm27xx_bcm{2712,2709}`
   tree does. `scripts/verify-profile-parity.js` (chained from
   `scripts/verify-sync-flow.js`) enforces this in CI — mechanics and how to
   run it are documented in `osi-flows-json-editing`.
6. Update this skill's tables (section 1–7) so the map stays accurate — one
   home per fact.
7. If the flag gates safety-relevant behavior (e.g. anything that could touch
   `farming.db` mutation risk, private-target allowance, or identity), add or
   extend a verifier/guard (`scripts/verify-communication-contract.js`,
   `scripts/verify-sync-flow.js`, or a new `scripts/verify-*.js`) rather than
   relying on manual review alone.
8. If the fact is durable repo-level knowledge (not a one-off), add a line to
   `AGENTS.md` — do not duplicate the detail here and there; cross-reference.

---

## Provenance and maintenance

This skill embeds knowledge gathered by reading repository source directly
(uci-defaults, `osi-gateway-identity.sh`, `chirpstack-bootstrap.js`,
`node-red.init`, `settings.js`, `deploy.sh`, flows.json, `docs/operations/edge-history-retention.md`,
`AGENTS.md`) on 2026-07-06 against the `feat/agent-skill-library` worktree.
The `deploy.sh` and ChirpStack-profile sections (1, 3, 6) were re-verified
2026-07-19 on `main` (deploy.sh payload-flip/migration-runner redesign;
Milesight UC512 added as a seventh ChirpStack device profile). Nothing here
should contradict `AGENTS.md`; if it does, `AGENTS.md` wins and this file is
stale — re-verify and fix.

Re-verify the whole surface in one pass:
```
grep -n "^set " conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config
diff conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-gateway-identity.sh
grep -n "CFG = {" -A 25 scripts/chirpstack-bootstrap.js
grep -n "OSI_HEALTH_.*_RETENTION_DAYS" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
grep -n "functionExternalModules\|protectedKeys" feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js
grep -n "^[a-z_]*() {" deploy.sh
grep -n "historyUxEnabled" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
node scripts/verify-communication-contract.js
node scripts/verify-profile-parity.js
```
