# Adding a new device type

Moved from `AGENTS.md` on 2026-10-27; it carries the same authority.

> **Why this is still a manual checklist:** there is no plugin registry — see ADR [`docs/adr/2026-05-28-static-device-plugin-registry.md`](../adr/2026-05-28-static-device-plugin-registry.md) for the deferral rationale. Do not propose a plugin system without a concrete second-party candidate.

1. Add an ordered migration `database/migrations/ordered/NNNN__<slug>.sql` and the matching `seed-blank.sql` change (load `osi-schema-change-control`); step 6 regenerates the bundled `farming.db` copies. A new `devices.type_id` member is a `destructive` ordered migration that rebuilds `devices` (SQLite cannot alter `CHECK` in place; precedent `0060__add_rak10701_field_tester_type.sql`), plus `REQUIRED_TYPES` and `DEVICES_COLUMNS` in `sync-init-fn` under the boot-node merge gate. Never add a second rebuild path.
2. Add TypeScript types (`web/react-gui/src/types/farming.ts`).
3. Add the payload codec under
   `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/`
   and mirror it byte-for-byte under
   `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/codecs/`.
   Add or extend a `scripts/verify-*.js` verifier with canonical uplink frames
   and expected decoded shapes (for example,
   [`scripts/verify-s2120-codec.js`](../../scripts/verify-s2120-codec.js)).
   Add Node-RED ingest flow in `flows.json` (use the `application/+/device/+/event/up` topic; guard the branch head with a `deviceProfileName` filter so other branches don't double-process the same message).
4. Add catalog / merge logic.
5. Add React card/component and render in dashboard.
6. Regenerate the bundled DB copies with `node scripts/build-seed-db.js` (it replays the ordered migrations into a fresh image, so the shipped ledger advances with the schema); verify with `scripts/verify-db-schema-consistency.js` and `scripts/verify-seed-db-ledger.js`.
7. Add the profile to `chirpstack-bootstrap.js` (all three copies: `scripts/` and both profiles) and map its ChirpStack application; if the flows filter on the profile ID, add its `CHIRPSTACK_PROFILE_*` key to `node-red.init`.
8. For Data-view support, update the finite source policy in both payload
   profiles and run the source matrix, manifest parity, and deploy-file coverage
   checks documented in [docs/channel-manifest.md](../channel-manifest.md).
