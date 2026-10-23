# History cursor deployment — 8 October 2026

The reviewed history acknowledgement fix from `34ab3c6bb` was applied to the field gateway on 7 October at 22:13 UTC (8 October locally). The change isolates repair/correction acknowledgements from ordered upload cursors. It does not change retention or perform an archive backfill.

## Activation and rollback

The operation patched a fresh copy of the live flows and proved that only `sync-history-mark.func` changed. Its pre-patch function hash matched the reviewed base. The existing GUI was copied without changes, preserving the flows/GUI payload pairing.

- Previous payload: `20261007T205233Z`.
- Active payload: `20261007T221220Z-history-cursor-34ab3c6bb`.
- Backup: `/data/db/backups/20261007T221220Z-history-cursor-34ab3c6bb`.
- Operation files and log: `/data/osi-ops/20261007T221220Z-history-cursor-34ab3c6bb`.
- Active function SHA-256: `c6e0b71558d9a08b2acc8b2f4f50a69b3cbb0020cbc3ad63f447e32895d3b44a`.

The backup includes an online SQLite backup with a passing integrity check, the Node-RED directory, init script, existing UCI configuration, flows, and GUI. Both archives passed readability checks. The first attempt stopped during backup because `/etc/config/node-red` was absent; it did not stop the service or activate a payload. The retry recorded that absence and backed up the existing `osi-server` UCI configuration.

The complete activation and automatic rollback operation ran detached from SSH. It checked the active payload, schema ledger, identity state, and active valve runs before changing links. Both payloads remain retained. Rollback, if required, must verify the retained payload's schema compatibility, stop Node-RED, restore both links with the saved `deploy-payload-swap.js` helper, restart, and repeat the boot and HTTP checks. Do not restore the old database to roll back this code-only change.

## Verification

The deployment exited 0. Fresh post-restart checks confirmed:

- Node-RED running and a new `sync-init: schema init complete` log marker, with no boot-abort marker.
- Dashboard HTTP 200 and unauthenticated history export HTTP 401.
- Matching active flows/GUI payload stamps and schema-head/ledger compatibility.
- Exactly one changed flow node and identical GUI contents.
- All 83,372 rows present at preflight still present after restart; subsequent sensor readings continued arriving.

The preflight cursor was 824. While backup was running, the old code acknowledged a batch at 22:12:54 UTC and moved it to 1049. This happened before activation and is not evidence of the fix.

The first acknowledgement under the new code occurred at 22:13:34 UTC and left the ordered cursor at 1049. The cloud accepted additional historical rows, including IDs greater than 1049, without that repair advancing the ordered cursor past unsent stream data. A read-only cloud check showed 910 indexed rows versus 821 before activation, and post-activation updates through source ID 1063. Retry and rejected-row counts remained zero.

The next scheduled batch completed at 22:17:34 UTC. A read-only cloud query confirmed 50 newly indexed rows, IDs 850–899, while the edge cursor remained 1049. Pending repairs fell from 250 to 200, completed dirty rows increased from 581 to 631, and retry/rejected counts remained zero. Cloud indexed rows reached 960. This directly corroborates that an older repair ACK no longer rewinds the stream.

Sol independently reviewed the deployment evidence as GREEN for dirty-ACK isolation and gateway health. Receipt growth is not a measurement of ordered tail progress or archive completion.

## Scope and remaining work

The source patch passed 30 focused tests, its worker-helper tests, and the broader edge verification gates. Sol reviewed the plan and implementation; the deployment script also received independent review before execution.

This verifies the cursor fix and gateway health, not completion of the archive transfer. The repair queue and ordinary history worker continue at their existing cadence. Cloud account raw retention remains 30 days. The orphaned-index, rollup-coverage, protocol-v1 channel, and key-cursor limitations from [the investigation](history-coverage-and-sync-cursor-2026-10-07.md) remain separate work.
