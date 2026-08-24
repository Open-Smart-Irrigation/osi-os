# Fable review brief — valve programme, two packages

**Purpose:** this is the entry point for the independent review. It exists so the
reviewer rules on *decisions*, not on prose, and so the questions arrive with the
evidence already attached.

**What is being asked:** rule on the nine open decisions in §3 (E4 has since been answered by the operator and is closed). Not "is this a good
plan" — specifically, for each decision, which option, and what would change your
answer. Where you disagree with a recommendation, say what evidence would be
needed to settle it rather than substituting a preference.

**What is NOT being asked:** implementation review. No code has been written for
either package. Both plans are contingent on these rulings.

---

## 1. The two packages

| | Package A | Package B |
|---|---|---|
| Topic | Edge→cloud sync parity for valve schedules | Consolidating two valve UI surfaces |
| Spec | `specs/2026-08-23-valve-cloud-parity-phase-b-design.md` | `specs/2026-08-24-valve-advanced-controls-consolidation-design.md` |
| Plan | `plans/2026-08-23-valve-cloud-parity-phase-b.md` | `plans/2026-08-24-valve-advanced-controls-consolidation.md` |
| Tracks | Phase B of the Phase A design | osi-os#171 |
| Touches | migration, contract, flows.json, osi-server (lockstep) | frontend; one edge migration only under E2 |

They are **independent** — neither blocks the other — with one collision: both
would take migration number `0024`. Whichever lands second takes the next.

Read `specs/2026-08-19-valve-control-design.md` (Phase A, shipped) first if you
have no context; both specs extend it rather than restating it.

## 2. Context the reviewer needs

**Phase A shipped and is live** on a bench Pi 4, including a hardware-verified
GEN2 (SV2) encoder — a real valve ACKed a daymask plan on FPort 25 and a clock
sync on FPort 13 on 2026-08-23.

**Four Phase A premises have since shifted**, one load-bearing:

- "every live gateway is cloud-linked" is false — the bench Pi 4 has no
  `sync_link_state` row at all. That was the stated reason to defer the sync
  triggers.
- **AgroLink is a separate cloud instance on a separate branch pair.** It cannot
  be used to justify work on this branch. (Corrected by the operator; an earlier
  draft got this wrong.)
- GEN2 shipped, so phasing has moved.
- The outbox now has a **measured** cost that did not exist as evidence in
  August: on one box, bulk insert with the `device_data` outbox trigger ran at
  2,083 rows/s versus 25,000 without it, and a `DEVICE_DATA` payload averages
  1,388 bytes for a measurement carrying ~100 bytes, because it denormalises
  device/zone metadata into every row.

## 3. The decisions

### Package A — sync parity (spec §5)

- **D1** Trigger-emitted outbox, or watermark? *(rec: trigger — the 12× cost is a
  telemetry problem, not a schedule-volume one)*
- **D2** Is the cloud authoritative for valve schedules? *(rec: no —
  edge-authoritative with commands; the server survey found no cloud→edge event
  mirror exists at all, `recordOutboxMirror` is dead code)*
- **D3** What should an unlinked gateway do? *(rec: backfill-on-link — otherwise
  schedules created before linking are invisible to the cloud forever, because
  the outbox only captures changes)*
- **D4** Does `valve_settings` stay edge-only? *(rec: yes for now; note it has
  neither `sync_version` nor `deleted_at`, so syncing it later is a column
  migration, not trigger-only)*
- **D5** Soft delete: carried field or distinct op? *(rec: carried, matching
  `irrigation_schedules`, which is the near-mirror; zones use the other pattern)*

**Three osi-server findings bear on these** (from a read-only survey of
`osi-server@main`) and are why a naive design would dead-letter rather than
retry: `resourceTypeFromOp` sends `VALVE_*` to `"EVENT"` with resource-id =
event_uuid, silently disabling watermark dedupe/ordering; an unmapped resource
type yields a null owner, which is **terminal** `ownership_denied`; and
retryable-vs-terminal is decided by literal exception message prefixes.
Consequence: **backfill ordering (parents before children) is part of D3.**

Unresolved and handed over deliberately: whether the resource key is
per-schedule (`schedule_uuid`) or per-zone. The obvious analogue misleads —
`irrigation_schedules` is one row per zone (`zone_id` UNIQUE) but
`valve_schedules` is many per device.

### Package B — advanced controls (spec §4)

- **E1** Where do advanced controls live? *(rec: a separate service view — these
  are commissioning actions, not daily ones, and one tap from OPEN is wrong)*
- **E2** Persist commanded aperture, and how labelled? *(rec: persist the
  commanded value with "set to 40%" framing; open sub-question: reuse
  `valve_actuation_expectations`, which already models commanded-vs-observed, or
  a cheap `valve_settings` column)*
- **E3** Reconcile the two capability flags or document the split? *(rec:
  document now, merge later — **interacts with D4**, since moving anything to
  `valve_settings` means it does not reach the cloud)*
- **E4** ~~What aperture does a scheduled open use?~~ **ANSWERED by the operator
  2026-08-24 — not for review.** `SET_PARTIAL_OPENING` is a ONE-TIME action and
  the default opening is always 100%, so a scheduled open always runs fully open
  and a 40% flush does not leak into later windows. **This answer reshapes E2**
  (see above): with no persistent position, "persist nothing" became a
  defensible option and any stored value must be an event, not state.
- **E5** The five items #171 already lists *(not in question; inherited)*

**Two hard constraints for Package B**, established by reading the code:

1. **Aperture is commanded but never observed.** Neither decoder reports
   position; `current_state` is binary; no column stores a percentage. A
   motorized valve at 40% is indistinguishable in the database from one fully
   open. Any UI can only show what was last *asked for*.
2. **Two capability flags, two tables:** `devices.strega_model`
   (STANDARD/MOTORIZED, gates partial opening) and
   `valve_settings.strega_generation` (GEN1/GEN2, selects scheduler encoding).
   Not redundant — a GEN2 motorized valve is valid — but undocumented, and a
   farmer meets both in different dialogs.

## 4. Where a reviewer should push hardest

Offered as the author's own read of the weakest points, not as a defence:

- **D3 + the ownership findings.** The recommendation (backfill) is the only
  option that makes "link an existing gateway" correct, but it collides with a
  server that terminally dead-letters unknown-owner events. If the ordering
  guarantee cannot be made, the recommendation may be wrong.
- **E2 after E4's answer.** The recommendation was rewritten once already when
  E4 came back one-shot. A recommendation that moves that much under one new
  fact deserves suspicion — in particular, whether persisting the event at all
  earns its keep, or whether the honest answer is now "persist nothing".
- **D1's consistency argument.** "Follow the existing pattern" is doing a lot of
  work in a codebase where that pattern has just been measured as expensive. The
  counter — that schedule volume is nothing like telemetry volume — is sound but
  convenient.
- **E2's honesty framing.** "Show the commanded value, labelled as commanded" may
  still mislead a farmer who reads any number as truth. The alternative (show
  nothing) is defensible.

## 5. Verification status

Both plans state their own gates. At the time of writing, on this branch:
109 frontend test files / 666 tests pass, typecheck clean, and 31 of 33 repo
gates pass — the two failures (`verify-dendro-contract-mirror`,
`verify-sync-op-parity`) are pre-existing and fail on `main` too.
`verify-sync-op-parity` is what Package A exists to fix.
