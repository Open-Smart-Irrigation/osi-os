# SDI-12 implementation review — consolidated verdict (2026-08-13)

Two independent Opus reviewers over `441c5146..the source branch` (21 commits), adjudicated
by the orchestrating session; six gates independently re-run and green. Every
finding below was verified against committed code before acceptance.

**Verdict: revise before merge.** The schema/data-path half is solid and
gate-verified; three localized defects block merge, all in flows wiring or
enumeration surfaces that no existing gate covers.

## Blockers

**IB1 — `scoped-device-config-guard` output wires are off by one (both profiles).**
The guard builds 26 outputs (`routeTable.length 25` + error output 25) but carries
27 wires: index 24 (`PUT /sdi12/config`) goes straight to `device-response` (the
endpoint never reaches `sdi12-config-auth-fn`/`-action-fn`, so it never writes),
and index 25 — the ERROR output — feeds `sdi12-config-auth-fn`, which in scoped
mode skips `verifyBearer` and proceeds to write `sdi12_probe_profile` + depths.
Every 401/403/404/500 from the guard, for ANY device-config route, triggers an
unauthorized sdi12 config write. Fix: realign the wire array (index 24 →
`sdi12-config-auth-fn`, index 25 → error response, drop the unreachable 27th);
add a behavioral denial test. Note: 20+ gates passed over this — the battery has
no function-node output/wire alignment check (follow-up candidate).

**IB2 — `merge-device-data` never emits `sdi12_probe_profile` / `sdi12_probe_status`
/ `sdi12_identity` (or `updated_at`).** The device object stops at
`sync_version`/`deleted_at`, so the card's status chip, "No probe profile"
fallback, pending banner, pending-age label, and the modal's unmatched-identity
display are all permanently dead. Fix: copy the four fields through
`merge-device-data` (upstream `SELECT d.*` already carries them).

**IB3 — "Build Telemetry" 24-field block is a permanent no-op.** It reads
`obj.vwc_1…soil_ec_8` from `data.object` (the ChirpStack codec output), but the
codec emits only `BatV/EXTI_Trigger/Payver/data_sum/Node_type` — channel values
exist only after `osi-sdi12-normalize` runs in `sdi12-write-fn`, on a different
wire. The MQTT live mirror carries 24 hard nulls forever. Root cause: the PLAN's
Task 9 Step 5 instruction was wrong (orchestrator error, not worker deviation);
the `sync_outbox`/`DEVICE_DATA_APPENDED` path is correct and carries real values.
Fix decision (pick one, record in spec): (a) drop the 24 null fields from Build
Telemetry and declare `DEVICE_DATA_APPENDED` the sole cloud carrier for SDI-12
channels, or (b) restructure telemetry to source from the normalized write. (a)
is recommended — smaller, honest, and the sync path already works.

## Should-fix

- **IS1** — profile change without a depths payload leaves stale channel-keyed
  depth keys (S4's "replace stale keys" regressed on the no-depths branch of
  `sdi12-config-action-fn`). Clear or re-key the map on profile change.
- **IS2** — `sdi12-write-fn` dead-letter `node.warn` fires on every uplink;
  S1 specified rate-limited. Add a per-device cooldown (context timestamp).
- **IS3** — `channels/registry.ts` `DRAGINO_SDI12` branch is unreachable:
  `HistoryCardDetailPage.tsx:232-235` builds a soil source context only when
  `chameleonEnabled`; SDI-12 falls to legacy soil defaults. Extend the page's
  soil-context condition to the new type.
- **IS4** — `IrrigationZoneCard.tsx:523-543` SDI-12 section omits `onRemove`;
  nodes cannot be unassigned from a zone. Pass it like every sibling section.

## Nits (fix opportunistically)

- **IN1** — `Sdi12SettingsModal` always sends `depths` (even `{}`), marking
  depths configured with an empty map.
- **IN2** — `sdi12-profiles-scope-fn` still logs "catalog read:" strings
  (byte-identical clone; relabel).
- **IN3** — execution report says "four" boot-node literals; five changed
  (all verified sanctioned; miscount only).
- **IN4** — `WORST_CHARS_PER_VALUE = 7` is optimistic (SDI-12 allows 9); at 9
  the 6-value profiles compute 57 > 51. Document the assumption or bench-verify
  actual value widths per probe.
- **IN5** — the atomic schema commit needed later commits (ratchet allowance,
  hash re-pin) to be gate-green; artifact atomicity held, process note only.
- **IN6** — `verify-device-integration` now runs in two workflows (codecs.yml
  + edge-behavior.yml); drop one.
- **IN7** — empty FPort 2 frames self-quarantine as `unparseable_sdi12:
  '(empty)'` on every uplink; consider treating empty as no-data without
  quarantine.

## Verified clean (highlights)

All three `sync-init-fn` boot literals + both devices triggers + repair script +
sentinel rehearsal + 7 bundled DBs + contracts (ledger B4/B5 edge half); parser
cardinality/NULL semantics (B1); FPort-2-only codec with two-byte 0xF0 skip
(B2); all matchers null (B7); identify state machine with both guards +
terminal `unmatched` (B8); write node complete per B9 with yellow dead-letter
status; scoped GET via byte-identical catalog guard clone; 8-type registration
allow-list including the LORAIN/UC512 repair; node ordering before the
journal-v2 cluster; bcm2709 byte-identical; `node-red.init` S2 lines present;
CSV export carries all 24 columns (B6 CSV half).

## After the fix wave

Re-run the full Task 18 battery, update the execution report, then the standing
remainder: osi-server lockstep plan (merge gate), bench captures
(de-provisionalize profiles; 0xA8 frame confirmation is the identify feature's
pre-merge gate).
