# W5 edge overlay inventory — what the customer branches still hold that `main` does not

Generated 2026-09-11 against osi-os `origin/main` = `2c9ef4c34`.
Companion to `docs/superpowers/specs/2026-09-11-w5-customer-overlays-design.md`.

This file answers one question for each commit on the two customer edge lines:
**after waves 3 and 4, is this change on `main`, and if not, is that because it
is customer-specific or because it was simply never ported?** The second case
is the one that matters — those are the follow-up ports, and they are listed
with SHAs in "Follow-up work" below.

## Method, and what the numbers are worth

Three passes, all reproducible from a clean checkout:

1. **Patch-identity.** `git cherry origin/main origin/<branch>` drops every
   commit whose patch-id already exists on `main` (a clean cherry-pick, or the
   same commit merged). What survives is the candidate set: 31 commits on
   `Valve-focused`, 422 on `AgroLink`.
2. **Content presence ("on main" column).** Patch-identity is far too strict
   here: wave 3 and wave 4 ported most of this content by hand, so the bytes
   landed with different context and a different SHA. The second pass takes
   every *added* line of each commit that is at least 12 characters and not
   pure punctuation, and asks whether that exact line exists anywhere in
   `main`'s copy of the same file. The percentage is how many did.
   90%+ reads as "this change is on main"; under 5% as "it is not".
3. **Code residue.** The percentage over-counts absence for two file classes:
   `docs/` and `.superpowers/` files that `main` deliberately never took, and
   `flows.json`, whose function bodies are single multi-kilobyte JSON string
   literals that never line-match after any edit. The third pass re-runs pass 2
   with those excluded, and reports `missing/added` **code** lines per commit.
   A `+flows` marker means the commit also edits `flows.json` and that part
   could not be measured this way — check it by hand.

A residue of `0/N` with a low "on main" percentage means the commit's real
content is on `main` and only its plan document is not. That combination is
common here and is why the raw percentage alone is not a verdict.

Reproduce:

```sh
git -C osi-os fetch origin
git -C osi-os cherry origin/main origin/Valve-focused | awk '$1=="+"{print $2}'
# then, per commit, diff its added lines against origin/main's copy of each file
git show --format= -U0 <sha> -- <path> | grep '^+'
git show origin/main:<path>
```

## Tags

| tag | meaning | what happens to it |
|---|---|---|
| `branding` | customer identity: wordmark, palette, chrome, product-name copy | moves to the `customer/*` overlay branch |
| `overlay-docs` | plan/spec/review documents written during the customer programme | stays on the customer branch, or is dropped; never a deploy concern |
| `superseded` | the content is on `main` (90%+ line presence) | nothing to do; do not re-port |
| `generic-leftover?` | partly on `main`; a real but bounded residue | confirm per commit, then port the residue |
| `generic-leftover` | not on `main`, and not customer-specific | port to `main` |

`generic-leftover?` is deliberately a question mark. The probe screens; it does
not adjudicate. Every item below was spot-checked by reading the residual
lines, but a worker picking one up should re-derive the residue before writing
code — `main` will have moved.

## `Valve-focused` (the Bovey edge line) — 31 candidate commits

| tag | count |
|---|---|
| overlay-docs | 13 |
| generic-leftover? | 6 |
| branding | 5 |
| superseded | 5 |
| generic-leftover | 2 |

Four of the eight leftover candidates carry real code residue; four carry none
(their whole residue is the plan document `main` never took). The four with
residue are the follow-up tasks.

| commit | date | tag | on main | residue | subject |
|---|---|---|---|---|---|
| `bbe710995ddf` | 2026-08-24 | generic-leftover | 32% | 9/25 | fix(valve-gui): confirm before the legacy card opens water; drop the retirement |
| `69874235f35c` | 2026-08-24 | generic-leftover | 0% | 0/0 +flows | feat(sync): carry valve_schedules in the bootstrap snapshot |
| `a63d08a96da0` | 2026-08-27 | generic-leftover? | 52% | 203/426 | feat(valves): one ValveTile everywhere on the edge -- retire StregaValveCard (C2) + tile last-seen/battery (I6) |
| `88c298b60565` | 2026-08-26 | generic-leftover? | 86% | 87/701 +flows | feat(valves): emit VALVE_ACTUATION_ARCHIVED on terminal transitions + backfill |
| `01af6eefd627` | 2026-08-24 | generic-leftover? | 84% | 12/155 | feat(valve-gui): show every valve's saved schedules in one place |
| `35aabffa47c0` | 2026-08-24 | generic-leftover? | 58% | 0/7 | fix(valve-gui): drop the device EUI from the valve tile |
| `8316ec468ac7` | 2026-08-25 | generic-leftover? | 84% | 0/10 +flows | fix(mqtt): make cloud MQTT broker URL configurable via UCI at link time |
| `e729a2447432` | 2026-08-26 | generic-leftover? | 64% | 0/7 +flows | i18n(valves): P5-3 -- retranslate planIncomplete, fix a stale bootstrap comment |
| `f8ecff490430` | 2026-08-21 | branding | 0% | 153/153 | feat(branding): Aqua-style brushed-aluminium light header + Bovey Cloud rename |
| `7ee2c8c16955` | 2026-08-20 | branding | 3% | 77/79 | feat(branding): Bovey corporate design — wordmark on login/header, Bovey palette |
| `e59558f6ff47` | 2026-08-21 | branding | 0% | 28/28 | feat(branding): real brushed-metal chrome; header shows only the welcome line |
| `3c27cf453d8a` | 2026-08-21 | branding | 0% | 19/19 | feat(branding): GUI states only Bovey — drop OSI OS name, version, and Alpha tag |
| `b3485e8b7aee` | 2026-08-21 | branding | 0% | 2/2 | style(branding): subtler brush streaks (texture alpha 0.16/0.14 -> 0.08/0.07) |
| `3d1fc0d0a847` | 2026-08-23 | overlay-docs | 0% | 0/0 | docs: Phase B edge→cloud valve parity — spec and implementation plan |
| `2b603a857838` | 2026-08-24 | overlay-docs | 0% | 0/0 | docs: advanced-controls consolidation spec + plan, and the fable review brief |
| `bb99bc488fec` | 2026-08-24 | overlay-docs | 0% | 0/0 | docs: E4 answered (partial opening is one-shot, default 100%) — unblocks partial opening, reshapes E2 |
| `410f5f324645` | 2026-08-24 | overlay-docs | 0% | 0/0 | docs: remove two self-contradictions E4's answer introduced |
| `d7aaab418579` | 2026-08-24 | overlay-docs | 0% | 0/0 | docs: correct four factual errors the review caught, before acting on its rulings |
| `c3332735a708` | 2026-08-24 | overlay-docs | 0% | 0/0 | docs: apply the review rulings to both plans |
| `965c16f0df7a` | 2026-08-24 | overlay-docs | 0% | 0/0 | docs: apply E1/E2/E3 rulings to plan B (earlier pass silently no-opped) |
| `bbbc549a526a` | 2026-08-24 | overlay-docs | 0% | 0/0 | docs: drop the stale 0024 collision note — plan B has no migration now |
| `e4a6891cca39` | 2026-08-24 | overlay-docs | 0% | 0/0 | docs: correct Task 1's gate expectation — verify-sync-contract goes red until Task 3 |
| `70187f6641f4` | 2026-08-24 | overlay-docs | 0% | 0/0 | docs(spec): Bovey cloud-edge parity design, decisions C1-C5 open for review |
| `a98c68173b28` | 2026-08-24 | overlay-docs | 0% | 0/0 | docs(spec): record C1-C5 rulings; C4/C5 overturned, C5 on sync-auth safety |
| `52f9012481ef` | 2026-08-25 | overlay-docs | 0% | 0/0 | docs(spec): record the 2026-08-25 full-parity decision; C-series read-only ruling superseded |
| `cbcbfa2c4852` | 2026-08-25 | overlay-docs | 0% | 0/0 | docs(plan): land the Bovey cloud full-parity program plan the spec addendum cites |
| `ab643cf982b4` | 2026-08-13 | superseded | 92% | 40/515 | feat(gui): one two-tab zone device modal for assign-existing and register-new |
| `05a4814f4713` | 2026-08-25 | superseded | 94% | 9/317 +flows | feat(valves): UPSERT_VALVE_SETTINGS cloud applier, registry wiring, bootstrap snapshot |
| `c7d94cb60315` | 2026-08-24 | superseded | 94% | 6/172 +flows | feat(sync): make observed weekly/on-valve runs reach the cloud |
| `bb3c7fba5259` | 2026-08-26 | superseded | 97% | 4/357 +flows | fix(valves): P4-E1 review fixes -- status derivation, backfill emit, LWW ties |
| `b8834291df1c` | 2026-08-24 | superseded | 95% | 0/63 +flows | fix(valves): carry partial-opening/flushing percentage into actuator_log |

## Follow-up work

### Bovey line — four ports, each small and self-contained

Ready to hand to a Sonnet worker as written. Each is a separate PR to `main`;
none depends on another. The residue figures are from 2026-09-11 against
`2c9ef4c34` — re-derive before starting.

**W5-F1 — `a63d08a96da0`, one ValveTile everywhere (residue 203/426).**
The largest real gap. `web/react-gui/src/components/farming/valves/DeviceValveTile.tsx`
(131 lines) does not exist on `main` at all; the rest is `ValveTile.tsx` (22
lines), `IrrigationZoneCard.tsx` (9), `FarmingDashboard.tsx` (7) and their
tests. Carries the 2026-08-27 operator ruling that the legacy STREGA device
card *stays* in the devices tab while the tile is the control surface in the
valve panel — port the ruling, not just the code. Touches `valves.json` in all
seven locales.

**W5-F2 — `88c298b60565`, VALVE_ACTUATION_ARCHIVED terminal-transition emit
(residue 87/701, plus unmeasured `flows.json`).** `main` already has the op,
the migration and the applier; what is missing is 29 lines in
`osi-valve-control/runtime.js` (identically in both the bcm2709 and bcm2712
profiles — keep the mirrors byte-identical), 9 in `runtime.test.js`, 6 in
`scripts/test-valve-actuation-bootstrap.js` and 1 in `cancel.js`. Check the
`flows.json` half by hand. Follow-up review commit `bb3c7fba5259` is already on
`main` at 97%, so port `88c298b60565`'s residue *on top of* the reviewed
behaviour, not instead of it.

**W5-F3 — `01af6eefd627`, all-valves schedule overview (residue 12/155).**
Four assertions in `ValveScheduleOverview.test.tsx` and one `valves.json` key
per locale. Small enough to fold into W5-F1 if the same worker takes both.

**W5-F4 — `bbe710995ddf`, confirm before the legacy card opens water (residue
9/25).** Two lines in `StregaValveCard.tsx` and one `devices.json` key per
locale. This is a safety behaviour — the legacy card could open a valve with no
confirmation — so it should not wait on the larger tile work.

Four further candidates need no port: `35aabffa47c0`, `8316ec468ac7`,
`e729a2447432` and `69874235f35c` all measure `0/N` code residue. Their whole
apparent absence is `docs/superpowers/plans/2026-08-24-valve-advanced-controls-consolidation.md`,
a plan document `main` never took. Confirm the `flows.json` halves of
`8316ec468ac7` (the cloud MQTT broker URL UCI fix — `main` does have
`mqtt_broker_url` in both profiles' `flows.json`) and `69874235f35c` by hand,
then close them.

**Locale rule, binding on W5-F1, F3 and F4.** These commits touch
`public/locales/lg/*.json`. Edge Luganda is human-translated and is a Uganda
ship gate; cloud Luganda is an English mirror by test. The two repos have
opposite rules. On the edge, *add* the new key with an English value and flag
it for the native pass — never overwrite an existing non-English value, and
never "align" edge `lg` to the cloud wording. Check with
`git show <base>:<file>` before editing.

### AgroLink line — triage, not a port queue

169 commits tagged `generic-leftover` or `generic-leftover?`. That number is an
artefact of a four-month parallel fork, not a measure of missing work, and
handing it to a worker as a backlog would waste the worker. Five bounded triage
batches instead, each ending in a verdict list (port / already on main /
drop), not code:

1. **ChirpStack helper rollback and key handling** — `347d88b1d05e` and its
   reapply `29301d0ddb60` (residue 2,582), `a62d01717f11`, `9ea84a289519`.
   Overlaps the known all-zero-AppKey and cross-tenant-takeover findings in the
   2026-08-13 branch review; check those are closed on `main` first.
2. **Sync fail-closed delivery** — `62f8d2dcec8d`, `88a366b92208`,
   `08a8ddf7a803`, `75bb0cf8d5f6`, `793dab9b352f`, `56f5810b2cca`. Wave 3 did
   port fail-closed work; establish what shape it took before porting anything.
3. **Device writer async contract** — `8abbc4424c07` / `61fd7f30d169`
   (residue 588), `b6b08ccbdcfe`, `5d0a4947cd98`.
4. **Scoped access API enforcement** — `c034b28933ab`, `30b526ed7594`,
   `832d48efe3c4`, `a6289e961e66`, `bc156fb25a17`, `54d1bf4287f5`,
   `4bb9001e3a03`. All measure 27–40%, consistent with a partial re-derivation.
   `main` has the scoped-access migrations; the question is which *route
   guards* came with them.
5. **Desired-state / protected-aggregate sync** — `9937ac6c650d`,
   `7bac1443f95f`, `bd2cf3a3b4c2`, `083cff108c12`, `1f861ed0b59c`,
   `be66dad668f8`, `80d5b2da0215`.

Batch 1 first: it is the only one whose residue touches a path with a recorded
security finding.

## `AgroLink` — 422 candidate commits

| tag | count |
|---|---|
| overlay-docs | 135 |
| superseded | 93 |
| generic-leftover | 87 |
| generic-leftover? | 87 |
| branding | 20 |

Read this table with more suspicion than the `Valve-focused` one. `AgroLink`
forked at `b31825be` and ran for four months in parallel; waves 3 and 4 ported
its content in reshaped form, so a commit that reads 20% here is often a
partial re-derivation rather than a gap. The residue column is the useful
ranking, and even it counts test files and locale files alongside production
code. Treat the top of the list as a queue to investigate, not a backlog to
execute.

Three specific distortions to know about before triaging:

- **`c044c17ca5ba` "add deployment state and guard primitives" (residue
  34,640)** dwarfs everything else because it lands generated provenance and
  vendored artefacts, not 34k lines of logic. It sits at the top of the ranking
  for mechanical reasons; do not read it as the largest gap.
- The `Revert`/`Reapply` pairs (`ee3c29ad5bfb`, `61fd7f30d169`, `29301d0ddb60`)
  double-count the same content. Triage the pair, not each commit.
- The `branding` tag is keyword-driven and over-reaches on this branch: it
  catches anything whose subject mentions Agroscope or AgroLink, including the
  Agroscope journal vocabulary (`66210d0b5dfd`) and the dark-theme
  `FormField.tsx` fix (`6d16d64483e0`), neither of which is customer identity.
  Re-read the 20 before assuming they all belong on the overlay.

| commit | date | tag | on main | residue | subject |
|---|---|---|---|---|---|
| `c044c17ca5ba` | 2026-07-19 | generic-leftover | 0% | 34640/34660 | feat: add deployment state and guard primitives |
| `347d88b1d05e` | 2026-07-16 | generic-leftover | 3% | 2582/2672 | fix(chirpstack-helper): fence-checked create rollback and explicit JoinEUI restore |
| `29301d0ddb60` | 2026-07-19 | generic-leftover | 3% | 2582/2672 | Reapply "fix(chirpstack-helper): fence-checked create rollback and explicit JoinEUI restore" |
| `9937ac6c650d` | 2026-07-24 | generic-leftover | 7% | 1646/1764 | feat(sync): apply protected device aggregate |
| `7bac1443f95f` | 2026-07-24 | generic-leftover | 11% | 1546/1709 | feat(sync): apply versioned irrigation config |
| `954b14c69a2f` | 2026-07-16 | generic-leftover | 0% | 1052/1052 +flows | fix: preserve Device API auth status through catch |
| `96c08c07ddbd` | 2026-07-19 | generic-leftover | 13% | 782/840 | fix: migrate the flow-size ratchet to absolute ceilings |
| `5d0a4947cd98` | 2026-07-19 | generic-leftover | 2% | 766/784 | fix: hard-fail missing edge ingest after ChirpStack uplink |
| `8abbc4424c07` | 2026-07-16 | generic-leftover | 9% | 588/645 | fix(device-writer): consume async db contract, fail closed on schema drift |
| `61fd7f30d169` | 2026-07-19 | generic-leftover | 9% | 588/645 | Reapply "fix(device-writer): consume async db contract, fail closed on schema drift" |
| `b6b08ccbdcfe` | 2026-07-19 | generic-leftover | 15% | 565/588 +flows | fix: restore guarded async LSN50 writer path |
| `793dab9b352f` | 2026-07-16 | generic-leftover | 0% | 540/540 | test(sync): add fail-closed delivery regression harness (RED on ack/commands by design) |
| `3a1ad5c79886` | 2026-07-25 | generic-leftover | 21% | 386/469 +flows | feat: complete portable history analysis actions |
| `c034b28933ab` | 2026-07-23 | generic-leftover | 28% | 335/433 +flows | feat(api): enforce device scope on read paths |
| `bd2cf3a3b4c2` | 2026-07-24 | generic-leftover | 7% | 329/337 +flows | feat(sync): advertise irrigation config desired state |
| `083cff108c12` | 2026-07-24 | generic-leftover | 6% | 295/300 +flows | feat(sync): advertise protected device state |
| `6d8dae6065ce` | 2026-08-13 | generic-leftover | 21% | 294/362 +flows | feat(sdi12): atomic schema slice - columns, type CHECK, boot literals, triggers, repair, bundled DBs |
| `9f4581393a1d` | 2026-08-29 | generic-leftover | 1% | 264/268 | feat(chirpstack): expose safe device queue operations |
| `62f8d2dcec8d` | 2026-07-16 | generic-leftover | 2% | 255/255 +flows | fix(sync): fail-closed statusCode + success gating in outbox/bootstrap mark |
| `bc156fb25a17` | 2026-07-23 | generic-leftover | 37% | 219/285 +flows | feat(api): enforce scoped zone lifecycle |
| `a6289e961e66` | 2026-07-23 | generic-leftover | 27% | 192/253 +flows | feat(api): enforce schedule scope and authority |
| `b7787c172594` | 2026-07-24 | generic-leftover | 26% | 174/236 | fix(sync): emit initial zone mirror event |
| `832d48efe3c4` | 2026-07-23 | generic-leftover | 33% | 168/239 +flows | feat(api): enforce fresh scope on valve effects |
| `ee3c29ad5bfb` | 2026-07-19 | generic-leftover | 4% | 144/150 | Revert "feat(sync-protocol-state): implement deployment protocol verbs" |
| `fe6f33fe0622` | 2026-07-19 | generic-leftover | 17% | 142/174 +flows | fix(chirpstack-flows): rewire flow nodes to the reconciling helper's new contract |
| `54d1bf4287f5` | 2026-07-24 | generic-leftover | 40% | 133/138 +flows | feat(api): admin-only guard on system and sync writes |
| `30b526ed7594` | 2026-07-23 | generic-leftover | 36% | 130/202 +flows | feat(api): scope history reads |
| `7b75c4de69c6` | 2026-08-12 | generic-leftover | 0% | 112/112 | fix(chirpstack-helper): accept ChirpStack 4.12+ zero-key read-back in verifyKeys |
| `c8168986da4f` | 2026-08-05 | generic-leftover | 27% | 108/148 | feat: osi-command-ledger recognizes VALVE_COMMAND as a physical action (S2) |
| `1f861ed0b59c` | 2026-07-24 | generic-leftover | 16% | 106/127 | feat(contract): stage protected device aggregate |
| `0f17892f1eff` | 2026-07-24 | generic-leftover | 33% | 103/141 | feat(contract): activate scoped access parity |
| `8a06e630bd9d` | 2026-07-23 | generic-leftover | 8% | 96/120 | test: define edge sync contract gate |
| `be66dad668f8` | 2026-07-24 | generic-leftover | 1% | 96/97 +flows | feat: activate versioned zone desired state |
| `9ea84a289519` | 2026-07-20 | generic-leftover | 4% | 87/87 +flows | fix: fence registration rollback and rejection ACKs |
| `6f27307db0b1` | 2026-08-03 | generic-leftover | 28% | 77/107 | fix(tooling): fail loudly when verify-sync-op-parity falls back off-worktree (E9) |
| `a62d01717f11` | 2026-07-20 | generic-leftover | 0% | 76/76 | fix(chirpstack-helper): record key snapshot before write, scope compensation fence |
| `80d5b2da0215` | 2026-07-24 | generic-leftover | 19% | 60/74 | fix(sync): bind hardware action effects |
| `4bb9001e3a03` | 2026-07-24 | generic-leftover | 13% | 59/68 | feat(gui): viewer read-only mode and disabled-account handling |
| `cf458e1ee73b` | 2026-07-20 | generic-leftover | 0% | 45/45 | ci: gate Train A edge behavior (sync fail-closed, writer, ChirpStack, pipeline) |
| `e58077b07962` | 2026-08-13 | generic-leftover | 6% | 44/47 | fix: enforce paired sync contract golden parity |
| `722b5787b3a8` | 2026-07-15 | generic-leftover | 14% | 43/50 | feat(gui): compact shared header + AppHeader on Data pages |
| `4fbd99db3584` | 2026-08-18 | generic-leftover | 4% | 41/43 +flows | fix(sdi12): sync sync-init-fn's boot-owned trigger literal for sdi12_value_count |
| `7486601c606f` | 2026-08-13 | generic-leftover | 14% | 36/42 | fix(ledger): treat missing expiry as a legacy issuer |
| `75bb0cf8d5f6` | 2026-07-19 | generic-leftover | 0% | 32/32 +flows | fix(sync): resolve command-ACK delivery by business commandId, not row PK |
| `ccb39eb2b78e` | 2026-07-19 | generic-leftover | 12% | 32/35 +flows | fix(sync): make work-request-status-apply idempotent on command replay |
| `ced1e8dcf8b6` | 2026-07-25 | generic-leftover | 14% | 31/38 | test: activate device sync contract |
| `e910c01f9f58` | 2026-08-05 | generic-leftover | 3% | 30/31 | fix(edge): stop hardcoding the MQTT broker URL to the original cloud |
| `a79460f8cfc5` | 2026-08-13 | generic-leftover | 6% | 30/32 | test(sync): compare edge and cloud contract goldens |
| `f8792aedced4` | 2026-08-13 | generic-leftover | 32% | 27/44 | fix(sync): stage the seven event ops the cloud cannot handle |
| `e1d487dd3fa4` | 2026-07-24 | generic-leftover | 8% | 26/29 | feat(contract): activate irrigation config parity |
| `6e536e607f41` | 2026-08-13 | generic-leftover | 0% | 26/26 | fix(chirpstack): reject an all-zero requested AppKey at validation |
| `af274c9c39fd` | 2026-07-23 | generic-leftover | 12% | 25/31 | feat(sync): enable journal contract operations |
| `841b2a61e3f9` | 2026-07-13 | generic-leftover | 4% | 23/24 | fix(gui): stop header overflow-hidden clipping its own dropdown menus |
| `441c51466291` | 2026-08-12 | generic-leftover | 0% | 23/23 | fix(tests): bound quoted-string scans at the newline, and stop the docstring lying |
| `28e22215a203` | 2026-08-03 | generic-leftover | 0% | 18/18 | fix(tooling): apply E9's loud-failure resolution to the test file's own SERVER_SOURCE (R5) |
| `5ff203728f9c` | 2026-07-25 | generic-leftover | 0% | 16/16 +flows | fix(sync): classify new outbox aggregates as protected |
| `a4ec878aa4de` | 2026-08-13 | generic-leftover | 10% | 16/18 | test: provide osiLib in residual harnesses |
| `f3128352b786` | 2026-08-13 | generic-leftover | 29% | 15/21 | test(edge): provide helper seams to verification harnesses |
| `6c761be7ece2` | 2026-08-13 | generic-leftover | 0% | 15/15 | test: preserve auth error response branch |
| `88a366b92208` | 2026-07-19 | generic-leftover | 0% | 13/13 +flows | fix: classify empty sync results as batch failures |
| `93fee44d258a` | 2026-08-03 | generic-leftover | 0% | 13/13 | docs(live-ops): note the 30s scope cache after a direct SQLite edit (E10) |
| `85dba0b4d7c6` | 2026-08-03 | generic-leftover | 26% | 11/17 +flows | fix(scope): deny disabled accounts before building the device list query (E4) |
| `7dd350eb988c` | 2026-07-20 | generic-leftover | 0% | 10/10 | style(layout): widen desktop content to 1600px to match the journal workspace |
| `56f5810b2cca` | 2026-07-19 | generic-leftover | 0% | 8/8 | test(verify-sync-flow): pin the 4 fixed nodes' fail-closed guards; re-measure ratchet |
| `0867f5f52628` | 2026-08-13 | generic-leftover | 0% | 6/6 | docs(sync): record replication and ledger compatibility |
| `a4431f2f9191` | 2026-07-19 | generic-leftover | 0% | 5/5 | test(gui): make vitest gate self-discover all src test dirs |
| `4202f231f7d4` | 2026-08-03 | generic-leftover | 29% | 5/7 | fix(sync): update the stale zone-calibration guard pin from E2 |
| `58470b5c180a` | 2026-08-13 | generic-leftover | 17% | 5/6 | test(gui): pin rendered device type selections |
| `deae71968e3b` | 2026-08-13 | generic-leftover | 0% | 4/4 | test(gui): restore selected device type regression |
| `718fd5a94489` | 2026-08-13 | generic-leftover | 0% | 4/4 | chore: retire completed flow migration generators |
| `089d25ef8932` | 2026-08-13 | generic-leftover | 0% | 4/4 | ci: wire the scoped-access write and read suites into edge-behavior (N-B) |
| `a4dcca07c69f` | 2026-07-14 | generic-leftover | 25% | 3/4 | feat(gui): align Register Account link beside the language switcher on login |
| `2f8cfdb90a4d` | 2026-07-19 | generic-leftover | 25% | 3/4 | fix(verify-sync-flow): realign 3 stale assertions with rewritten flow nodes |
| `a808f2fddb4e` | 2026-07-14 | generic-leftover | 33% | 2/3 | fix(gui): catch-all route falls back to dashboard |
| `ad1e9058d07e` | 2026-07-19 | generic-leftover | 0% | 2/2 | test: align device api ratchet test with absolute ceilings |
| `620b161a53a0` | 2026-07-16 | generic-leftover | 0% | 1/1 | test(journal): discover Phase 2 unit suites |
| `7495b90b2dda` | 2026-07-19 | generic-leftover | 0% | 1/1 | fix: rederive absolute ceilings for device api auth slice |
| `7bc5b6ad7671` | 2026-07-19 | generic-leftover | 0% | n/a | feat: add factory image provenance and baseline bootstrap |
| `cb2d34410c14` | 2026-07-19 | generic-leftover | 0% | n/a | fix: harden factory image provenance bootstrap |
| `57fd15dd8559` | 2026-07-19 | generic-leftover | 0% | n/a | fix: close factory bootstrap validation gaps |
| `019e8ff1b0b7` | 2026-07-19 | generic-leftover | 0% | n/a | fix: align factory bootstrap contracts |
| `9b75bdcc71c1` | 2026-07-19 | generic-leftover | -1% | 0/0 | fix: preserve protocol capability CLI executable mode |
| `716ea6f7bfd6` | 2026-07-19 | generic-leftover | -1% | 0/0 | Revert "fix: preserve protocol capability CLI executable mode" |
| `08a8ddf7a803` | 2026-07-19 | generic-leftover | 0% | 0/0 +flows | fix(sync): fail-closed command-ACK and command-guard handling in 4 flow nodes |
| `5d517ff52465` | 2026-08-13 | generic-leftover | 0% | n/a | fix(image): refresh factory-image provenance hashes and gate them in CI |
| `1e949114a350` | 2026-08-13 | generic-leftover | -1% | 0/0 | chore(scope): retire completed migration generators |
| `3479ab4191b9` | 2026-08-13 | generic-leftover | -1% | 0/0 | chore: retire stale LSN50 Chameleon verifier |
| `b53bf44e5c12` | 2026-08-09 | generic-leftover? | 87% | 362/2886 | feat(journal): queue cloud-primary edge mutations |
| `1839ac8e3ee3` | 2026-07-24 | generic-leftover? | 52% | 322/463 +flows | feat(api): admin account + grant management endpoints (W8), scoped zone config (W7) |
| `33eb12b94079` | 2026-07-24 | generic-leftover? | 69% | 309/1098 +flows | feat(sync): apply weather station zone commands |
| `9016d220d494` | 2026-07-24 | generic-leftover? | 86% | 260/1777 +flows | feat(sync): apply versioned zone commands |
| `1f6f09331a9d` | 2026-07-23 | generic-leftover? | 67% | 242/747 | feat(schema): add scoped access migrations |
| `29ff9d08a924` | 2026-07-23 | generic-leftover? | 46% | 225/418 +flows | feat(api): enforce scope on zone and device reads |
| `d49e1cd281bd` | 2026-07-23 | generic-leftover? | 54% | 222/457 +flows | feat(api): scope shared analysis reads |
| `e573479627e6` | 2026-07-22 | generic-leftover? | 75% | 200/695 | feat(journal): relax Full-mode irrigation requiredness + 16 open-field vegetables (catalog v7) + wider desktop capture modal |
| `c0a60430597a` | 2026-08-13 | generic-leftover? | 41% | 182/311 | test(ci): expand edge review coverage |
| `7cafb763fba5` | 2026-07-17 | generic-leftover? | 88% | 181/1452 | feat(sync-protocol-state): add load verification and initialize/status surface |
| `5186af2b4091` | 2026-07-19 | generic-leftover? | 76% | 159/662 | i18n(gui): wave 3 — finish device settings, account linking, dashboard |
| `b72f316a8617` | 2026-07-15 | generic-leftover? | 55% | 128/283 | feat(gui): shared AppHeader + Zones/Data/Journal IA + enriched liquid glass |
| `8b038affa0c9` | 2026-08-26 | generic-leftover? | 87% | 128/1263 +flows | feat(sdi12): ingest Sentek VWC and TriSCAN VIC |
| `017b867ed55d` | 2026-08-18 | generic-leftover? | 74% | 126/519 +flows | feat(sdi12): per-device learned value count (option b), correct 9-char budget, HydraScout excluded from variable-count treatment |
| `310411e1e6b5` | 2026-07-20 | generic-leftover? | 57% | 123/289 | feat(journal): Slice D phase 1 - crop-cycle schema + crop vocab (D1.1/D1.2) |
| `1659881d408c` | 2026-07-24 | generic-leftover? | 58% | 120/178 +flows | feat(api): fresh scope checks on device config writes |
| `b10d098a741d` | 2026-08-08 | generic-leftover? | 46% | 115/214 | feat(journal): add v2 replication contract acceptance |
| `e961b26020fd` | 2026-07-24 | generic-leftover? | 47% | 112/212 | feat(gui): scoped navigation, zone/plot pickers |
| `46f1d0fc814a` | 2026-07-23 | generic-leftover? | 66% | 107/320 +flows | feat(journal): apply union rule to reads |
| `77d3c52a03df` | 2026-07-25 | generic-leftover? | 78% | 103/769 +flows | feat: add stable installation identity on edge |
| `708e11410dba` | 2026-07-23 | generic-leftover? | 84% | 102/649 +flows | feat(api): require admin for diagnostic reads |
| `85b8575a05ec` | 2026-07-22 | generic-leftover? | 87% | 100/741 | feat(journal): treated_area optional everywhere + prefilled from plot area (catalog v8) |
| `9e6e334d12c7` | 2026-07-21 | generic-leftover? | 90% | 98/966 | feat(journal): Slice E - Full per-activity field scoping + progressive disclosure (D14/R5) |
| `64d72f908dca` | 2026-07-24 | generic-leftover? | 71% | 84/300 | feat(sync): version irrigation calibration |
| `e5ae977637d2` | 2026-08-14 | generic-leftover? | 71% | 82/300 +flows | fix(schema): split outbox payload json_object under the gateway sqlite3 arg limit |
| `568d7f525e85` | 2026-07-24 | generic-leftover? | 52% | 81/251 | feat(sync): stage protected zone contract |
| `ae9741880e03` | 2026-07-24 | generic-leftover? | 71% | 76/267 | feat(sync): version weather station zones |
| `4aa0af04b77c` | 2026-07-17 | generic-leftover? | 68% | 61/244 | test(journal): pin open-field activation SLA |
| `8fc838743e07` | 2026-08-13 | generic-leftover? | 55% | 61/135 | fix(gui): register the selected device type |
| `d588254354fa` | 2026-07-23 | generic-leftover? | 90% | 48/456 | feat(scope): add scoped access helper |
| `0ab000c5ec43` | 2026-08-29 | generic-leftover? | 84% | 46/478 | feat(sdi12): compile Sentek acquisition recipes |
| `480ecd1f5350` | 2026-07-23 | generic-leftover? | 76% | 42/176 | test: add scoped-access endpoint ratchet |
| `1b8736c6e906` | 2026-08-18 | generic-leftover? | 58% | 40/117 +flows | fix(sdi12): Fable A6 review SHOULD-FIX 1-3 + correct the 0047 EUI overclaim |
| `0d917961a226` | 2026-08-29 | generic-leftover? | 90% | 37/356 | fix: harden SDI-12 recipe flow responses |
| `5c36eda1e1e4` | 2026-08-29 | generic-leftover? | 83% | 30/190 | feat(sdi12): add recipe deployment state |
| `19d68c12ff7c` | 2026-07-24 | generic-leftover? | 77% | 27/115 | feat(gui): scope profile context from /api/me |
| `2cda6ae8a831` | 2026-08-13 | generic-leftover? | 52% | 21/57 +flows | fix(sdi12): close review findings and refresh evidence |
| `a96bd93d3770` | 2026-08-29 | generic-leftover? | 83% | 20/117 | feat(gui): add SDI-12 recipe API boundary |
| `e1e1640df9fd` | 2026-07-16 | generic-leftover? | 86% | 19/134 | feat(journal): typed journalApi client over the Slice-1 routes |
| `91187b40fe92` | 2026-08-18 | generic-leftover? | 87% | 17/168 +flows | feat(sdi12): auto-identify on cloud registration + first join; honest-wait UX |
| `d2e81bd6aa6f` | 2026-08-13 | generic-leftover? | 68% | 16/154 +flows | fix(edge): close auth and scoped-access review gaps |
| `344a1c47cbe3` | 2026-08-19 | generic-leftover? | 54% | 16/32 | feat(device-writer): quarantineOnly export for pre-normalize dead-letters |
| `484fb6a10a6b` | 2026-08-13 | generic-leftover? | 72% | 15/50 | feat(sdi12): chirpstack profile + codec provisioning |
| `9a3094a63a91` | 2026-08-13 | generic-leftover? | 63% | 14/61 +flows | feat(scope): accept an explicit optional zone_id on device registration |
| `d16bc7a0495b` | 2026-08-04 | generic-leftover? | 83% | 11/64 | feat: ui-core vendor-parity verifier and CI workflow (osi-os side) |
| `22a6e0a4c452` | 2026-08-13 | generic-leftover? | 86% | 11/159 +flows | feat(sdi12): device type, latest-data/export plumbing, soil card |
| `448d93f6c711` | 2026-07-19 | generic-leftover? | 88% | 9/83 | fix(journal): honest scope-limitation notice, shared status badge class, stale export-error clear |
| `6d63c15fca34` | 2026-08-05 | generic-leftover? | 50% | 9/18 | fix(edge): stop double-invoking write-strega-expectation on cloud commands |
| `79b3171ae0d0` | 2026-07-16 | generic-leftover? | 68% | 7/63 | i18n(journal): label the layout axis 'Layout', not 'Growing setting' |
| `31fd939ddd50` | 2026-07-23 | generic-leftover? | 86% | 6/43 | test: ratchet scoped analysis contract |
| `97b70ab12fc1` | 2026-08-13 | generic-leftover? | 83% | 6/82 +flows | feat(scope): resolve zoneUuid on the REGISTER_DEVICE command applier |
| `d79a788fcea8` | 2026-08-18 | generic-leftover? | 57% | 6/22 +flows | fix(sdi12): self-heal legacy rows with NULL chirpstack_app_id on identify |
| `36c5e40d8278` | 2026-07-20 | generic-leftover? | 43% | 4/7 | fix(ci): green migrations, field-journal, and verify-sync-flow checks |
| `efd744de403e` | 2026-08-12 | generic-leftover? | 75% | 3/30 +flows | feat(scope): make history zone reads account-wide, keep gateway and workspace gates |
| `10a097e92864` | 2026-08-13 | generic-leftover? | 80% | 3/38 +flows | fix(chirpstack): fence REGISTER_DEVICE on claimed EUI |
| `1e7f2fe54bb4` | 2026-08-13 | generic-leftover? | 62% | 3/8 | test(sync): pin staged event operations |
| `7d07aa341c7b` | 2026-08-18 | generic-leftover? | 72% | 3/37 +flows | fix(sdi12): persist chirpstack_app_id on registration; cs-reg-cloud-fn gains DRAGINO_SDI12 |
| `f712efb99569` | 2026-07-24 | generic-leftover? | 75% | 2/26 +flows | fix(flows): make scoped zone route metadata verifier-safe |
| `cfeac77e2765` | 2026-08-13 | generic-leftover? | 73% | 2/35 +flows | fix(scope): gate the REGISTER_DEVICE zone seam on scoped mode |
| `7343540d5928` | 2026-07-16 | generic-leftover? | 43% | 0/3 | test(journal): strengthen catalog definition assertions |
| `d94270d5d8fb` | 2026-08-03 | generic-leftover? | 87% | 0/39 +flows | fix(sync): emit outbox event on first-ever zone calibration save (E2) |
| `17462573a2d2` | 2026-08-03 | generic-leftover? | 76% | 0/113 +flows | fix(scope): replace viewer-denylist with a canMutate() allowlist on every mutation gate (E6) |
| `75e4eaee1178` | 2026-08-03 | generic-leftover? | 75% | 0/18 +flows | fix(scope): correct grant-POST operator precedence and 400-vs-404 (E7) |
| `76c40e4c9d21` | 2026-08-03 | generic-leftover? | 77% | 0/20 +flows | fix(scope): scope disable-all-schedules admins to owned-plus-granted zones (E8) |
| `002033014928` | 2026-08-03 | generic-leftover? | 90% | 0/53 +flows | fix(actuation): move the E3 scope gate ahead of duration parsing (R3) |
| `e8086340f120` | 2026-08-03 | generic-leftover? | 83% | 0/48 +flows | fix(actuation): propagate the cloud actor across the cloud->edge boundary (R1, Critical) |
| `76592c3a4c0f` | 2026-08-03 | generic-leftover? | 88% | 0/57 +flows | fix(actuation): exempt genuine scheduler dispatch from the E3 actor requirement (R2) |
| `9a3624fb0be4` | 2026-08-03 | generic-leftover? | 80% | 0/24 +flows | fix(actuation): queue a terminal ack when an actor is present but denied (R4) |
| `37dc1a0b29a1` | 2026-08-04 | generic-leftover? | 79% | 0/23 +flows | fix(actuation): don't treat transient scope-helper infra errors as denials (X1) |
| `71b8103d577c` | 2026-08-12 | generic-leftover? | 82% | 0/53 +flows | feat(scope): make device and zone list reads account-wide |
| `e82c1e480fc9` | 2026-08-12 | generic-leftover? | 75% | 0/30 +flows | feat(scope): make zone environment and recommendation reads account-wide |
| `43cb2191b1a6` | 2026-08-12 | generic-leftover? | 67% | 0/61 +flows | feat(scope): make all device-detail reads account-wide, including unassigned devices |
| `3a416c3e6f28` | 2026-08-13 | generic-leftover? | 90% | 0/102 +flows | feat(scope): make sensor export, actuations and analysis reads account-wide |
| `06c94d1b23ae` | 2026-08-13 | generic-leftover? | 70% | 0/14 +flows | fix(scope): keep cloud-assigned devices visible in device lists |
| `a3ced0ca3187` | 2026-08-13 | generic-leftover? | 82% | 0/27 +flows | fix(scope): apply the admin gate to gateway card-preference writes |
| `7ddbe5dd4eaf` | 2026-08-13 | generic-leftover? | 89% | 0/97 +flows | fix(zones): preserve device assignments during scoped registration |
| `f6b316266f15` | 2026-08-13 | generic-leftover? | 85% | 0/47 +flows | fix(edge): harden scoped cloud device registration |
| `38b9255de733` | 2026-08-13 | generic-leftover? | 86% | 0/0 +flows | feat(sdi12): ingest tab - strict profile gate, config read, narrow-waist write |
| `16b2642923ad` | 2026-08-13 | generic-leftover? | 86% | 0/0 +flows | feat(sdi12): aI! auto-identification via 0xA8 downlink + FPort 100 handler |
| `38965af379d5` | 2026-08-13 | generic-leftover? | 74% | 0/0 +flows | feat(sdi12): registration - catalog, auth allow-list (incl. lorain/uc512 fix), chirpstack maps |
| `8068e974a357` | 2026-08-13 | generic-leftover? | 50% | 0/0 +flows | fix(sdi12): include DRAGINO_SDI12 in scheduler swt source |
| `9894db7e7a71` | 2026-08-13 | generic-leftover? | 54% | 0/7 +flows | fix(sdi12): plumb probe state through device cards |
| `09b806eaf9e9` | 2026-08-13 | generic-leftover? | 60% | 0/0 +flows | fix(sdi12): remove dead SDI-12 telemetry fields |
| `e5e6648095f9` | 2026-08-15 | generic-leftover? | 56% | 0/3 +flows | feat(health): heartbeat carries sync_rejected_recent |
| `bbf717796faf` | 2026-08-17 | generic-leftover? | 50% | 0/0 +flows | fix(sdi12): config read - prepared sqlite binds msg.params and node.sql, not payload/topic |
| `85d8ef14bc48` | 2026-08-19 | generic-leftover? | 41% | 0/0 +flows | feat(sdi12): gate reassembles payver-2 multi-segment uplinks; write node records incomplete sequences |
| `fab3072ce6fd` | 2026-08-20 | generic-leftover? | 88% | 0/26 +flows | fix(sdi12): review fixes - durable quarantine for unsupported payload versions, window-before-duplicate reset ordering, two reassembler test gaps |
| `f4a4908f121b` | 2026-07-12 | branding | 4% | n/a | feat: re-apply AgroLink Agroscope branding onto refactored main |
| `8aa108cb3082` | 2026-07-12 | branding | 0% | n/a | fix: address fable review — AgroLink browser title, test name, drop CONTEXT.md |
| `46d809cce4f4` | 2026-07-13 | branding | 0% | n/a | chore(design-sync): AgroLink design-system sync inputs |
| `18c301dcebf0` | 2026-07-14 | branding | 15% | n/a | feat(gui): Variant A header — Agroscope Balken on white, neutral header, Noto Sans |
| `8c7076ca7cfe` | 2026-07-14 | branding | 0% | n/a | feat(gui): refine login card — larger AgroLink wordmark, quiet register link |
| `d92fabc2e65a` | 2026-07-14 | branding | -1% | n/a | feat(gui): AgroLink favicon — Agroscope-red square with white Noto Sans A |
| `7b044b553672` | 2026-07-14 | branding | 0% | n/a | feat(gui): liquid-glass chrome — iOS-26-style material for AgroLink |
| `20013750df30` | 2026-07-14 | branding | 0% | n/a | docs(design-sync): record liquid-glass material decisions in NOTES |
| `0449ef8a78ed` | 2026-07-15 | branding | 0% | n/a | feat(gui): align Agroscope wordmark to content-left; journal UX design doc |
| `14481670a072` | 2026-07-15 | branding | 0% | n/a | chore(design-sync): AppHeader card + refreshed DashboardHeader in DS project |
| `f1c31253d368` | 2026-07-15 | branding | 11% | n/a | fix(gui): omit header greeting; align Balken crown at all viewport widths |
| `46c3082ee48c` | 2026-07-16 | branding | 5% | n/a | fix(gui): keep the AgroLink header on two rows and touch-sized on phones |
| `2dabc9f9e0d6` | 2026-07-20 | branding | 0% | n/a | style(header): widen Agroscope balken crown to span the card width |
| `500f26112adc` | 2026-07-20 | branding | 0% | n/a | style(header): align balken left edge with the cards (drop left full-bleed) |
| `66210d0b5dfd` | 2026-07-22 | branding | 89% | n/a | feat(journal): detailed Agroscope activity vocabulary on the farmer path (catalog v9) |
| `f8bfe3fe0458` | 2026-07-23 | branding | 75% | n/a | fix(journal-gui): show the operation as the primary label + field, and render the Balken correctly on mobile |
| `de9a53dff2b9` | 2026-07-30 | branding | 21% | n/a | fix: close AgroLink parity review gaps |
| `dd5461335e94` | 2026-08-03 | branding | 0% | n/a | docs(agrolink): retarget branch references to AgroLink after rename |
| `6d16d64483e0` | 2026-08-06 | branding | 65% | n/a | fix(gui): FormField.tsx bg-white makes every input unreadable in dark theme |
| `637a5989d817` | 2026-08-18 | branding | 0% | n/a | fix(header): tabs read as the primary navigation over chrome buttons (F2, paired with osi-server) |
| `dc5b82f96261` | 2026-07-14 | overlay-docs | 0% | n/a | docs(design): AgroLink IA change + page-alignment audit |
| `a0d3e80dad80` | 2026-07-14 | overlay-docs | 0% | n/a | docs(design): resolve alignment decisions A/B/C |
| `ed478698cc17` | 2026-07-15 | overlay-docs | 0% | n/a | docs(design): trim prose; mark AppHeader/tabs/journal-page shipped in audit |
| `9536845e91d8` | 2026-07-15 | overlay-docs | 0% | n/a | docs(plan): field journal Slice 2 (edge GUI) implementation plan |
| `40476803baa6` | 2026-07-15 | overlay-docs | 0% | n/a | docs(plan): field journal Slice 2 Phase 0 — catalog definitions + labels delivery |
| `d5c5b73d23ff` | 2026-07-15 | overlay-docs | 0% | n/a | docs(prompt): autonomous overnight implementation prompt for field journal Slice 2 |
| `f651b0ec0f30` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): initialize Slice 2 autonomous run log |
| `6763569f4510` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): record Slice 2 preflight blocker |
| `8401a03bc920` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): record Phase 0 green evidence |
| `dc7bbef1a47c` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): correct Phase 1 GUI wire contract |
| `0d57bda17aba` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): record Phase 1 type review |
| `fa4156ca7548` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): harden Phase 2 execution plan |
| `74d4d3f190cd` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): record Phase 2 execution deviations |
| `b35f1fe58a1e` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): make phase 3 execution-ready |
| `901af0d9f2c8` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): record phase 3 task 8 |
| `08bbe7f29c07` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): record phase 3 tasks 9 and 10 |
| `d97c8b4fdc36` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): record task 11 hard stop |
| `6c6fc4533141` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): clear task 11 hard stop |
| `7c5b3e8cb268` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): catalog completeness findings from Slice 2 review |
| `b527e8ff1504` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): controller-facing review findings for the Slice 2 run |
| `a3f59dc822b5` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): record task 13 completion |
| `52977a9d7b9a` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): accept Task 13; record F5 as an accepted deviation |
| `31082aae875f` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): record task 14 verification blocker |
| `3cb950c8443d` | 2026-07-16 | overlay-docs | 0% | n/a | docs(journal): Task 14 review — F6 crop-edit defect, F7 SLA evidence gap |
| `dd70ff2e8d35` | 2026-07-17 | overlay-docs | 0% | n/a | docs(journal): record Task 14 product hard stop |
| `eb8c7e8c3e23` | 2026-07-17 | overlay-docs | 0% | n/a | docs(journal): clear Task 14 F7 hard stop |
| `bbb85004ec17` | 2026-07-17 | overlay-docs | 0% | n/a | docs(journal): Phase 3 review of tasks 8-12 |
| `923b76b6828d` | 2026-07-17 | overlay-docs | 0% | n/a | docs(journal): accept Task 14; close the external-approval record gap |
| `71690d8b4687` | 2026-07-17 | overlay-docs | 0% | n/a | docs(journal): define Slice 2 Phase 4 GUI execution |
| `93ab1c7b9873` | 2026-07-17 | overlay-docs | 0% | n/a | docs(journal): record Slice 2 Phase 4 Task 15 |
| `195c35241ca0` | 2026-07-17 | overlay-docs | 0% | n/a | docs(journal): record Slice 2 Phase 4 Task 16 |
| `48aa4f491a22` | 2026-07-18 | overlay-docs | 0% | n/a | docs(journal): record Slice 2 Phase 4 Task 17 |
| `5ceffe97fb02` | 2026-07-18 | overlay-docs | 0% | n/a | docs(journal): record Slice 2 Phase 4 Task 18 |
| `71454d73a39e` | 2026-07-18 | overlay-docs | 0% | n/a | docs(journal): record Slice 2 Phase 4 Task 19 |
| `89efbcfbae9e` | 2026-07-18 | overlay-docs | 0% | n/a | docs(journal): record Slice 2 Phase 4 Task 20 |
| `5894189b9ebe` | 2026-07-18 | overlay-docs | 0% | n/a | docs(journal): record Slice 2 Phase 4 Task 21 |
| `9f26aa948874` | 2026-07-18 | overlay-docs | 0% | n/a | docs(journal): record Slice 2 Phase 4 Task 22 |
| `06d6d77eb4bf` | 2026-07-18 | overlay-docs | 0% | n/a | docs(journal): record Slice 2 Phase 4 Task 23 |
| `67556b4dd8d5` | 2026-07-19 | overlay-docs | 0% | n/a | docs(journal): Phase 3 review of tasks 9, 10, 12 |
| `294d027ec388` | 2026-07-19 | overlay-docs | 0% | n/a | docs(journal): record Slice 2 Phase 4 Task 24 |
| `10bdc74a4e53` | 2026-07-19 | overlay-docs | 0% | n/a | docs(journal): Phase 4 partial review — P6 batch retry idempotency |
| `dd765b386269` | 2026-07-19 | overlay-docs | 0% | n/a | docs(journal): P6 resolution — batch must be idempotent like single-plot |
| `f835fd12ba2e` | 2026-07-19 | overlay-docs | 0% | n/a | docs(journal): confirm three design decisions (F7, P4, F1) |
| `14a9f4c99e3b` | 2026-07-19 | overlay-docs | 0% | n/a | docs(i18n): translation review pack for native/domain reviewers |
| `1b2d3cfe65ab` | 2026-07-19 | overlay-docs | 0% | n/a | docs(journal): Phase 4 where/ review — clean |
| `f5dc36ab9040` | 2026-07-19 | overlay-docs | 0% | n/a | docs(journal): decompose Slice 2 final phases |
| `c9eb4e3a7e0c` | 2026-07-19 | overlay-docs | 0% | n/a | docs(journal): accept P6 + Task 26 (P1/P2/P3/F8 closed) |
| `93d233417fd3` | 2026-07-19 | overlay-docs | 0% | n/a | docs(journal): Slice 2 Phase 5-6 merge-readiness + run ledger |
| `2bb0c44da671` | 2026-07-19 | overlay-docs | 1% | n/a | docs: record Train A finalization plan |
| `e36d2afe446c` | 2026-07-19 | overlay-docs | 0% | n/a | docs: record A0 ratchet approval |
| `0638f3fd7b8d` | 2026-07-19 | overlay-docs | 0% | n/a | docs: record A0 commit 1 approval |
| `c666966bb6c1` | 2026-07-19 | overlay-docs | 0% | n/a | docs: record A0 commit 2 approval |
| `f6e232e62a73` | 2026-07-19 | overlay-docs | 0% | n/a | docs: record safe Train A handoff and blockers |
| `4abe95c235e8` | 2026-07-19 | overlay-docs | 0% | n/a | docs: pin final handoff head |
| `edf99bdafd01` | 2026-07-20 | overlay-docs | 0% | n/a | docs(journal): record kaba100 live verification + crypto.randomUUID fix + desktop capture |
| `e8fd75111688` | 2026-07-20 | overlay-docs | 0% | n/a | docs(journal): capture-streamlining + crop-cycle spec and 5 slice plans |
| `0b41e60e0e24` | 2026-07-23 | overlay-docs | 67% | n/a | docs: prepare AgroLink parity orchestrator |
| `ce8656d9e5f3` | 2026-07-23 | overlay-docs | 0% | n/a | docs: finalize AgroLink parity handoff |
| `5fc265bb1159` | 2026-07-23 | overlay-docs | 64% | n/a | docs: finalize sequential AgroLink parity handoff |
| `b0b099868fc3` | 2026-07-23 | overlay-docs | 0% | n/a | docs: record AgroLink orchestrator integration |
| `6a4271b0d502` | 2026-07-23 | overlay-docs | 0% | n/a | docs: correct quarantined worktree inventory |
| `ed89dc010cfc` | 2026-07-23 | overlay-docs | 0% | n/a | docs: record AgroLink parity baseline |
| `459cf73f010a` | 2026-07-23 | overlay-docs | 7% | n/a | docs: refresh scoped access governance |
| `7c903b0e2621` | 2026-07-23 | overlay-docs | 0% | n/a | docs: record scoped governance refresh |
| `2913b5e8de8f` | 2026-07-23 | overlay-docs | 0% | n/a | docs: record sync contract gate |
| `239af47a45ca` | 2026-07-23 | overlay-docs | 0% | n/a | docs: record scoped access phase A |
| `412267fef0d9` | 2026-07-23 | overlay-docs | 0% | n/a | docs: design cloud desired state |
| `722fd1607af6` | 2026-07-23 | overlay-docs | 0% | n/a | docs: plan cloud desired state |
| `ce19950bbb4a` | 2026-07-23 | overlay-docs | 0% | n/a | docs: align desired state plan with Java 17 |
| `c9a3fb527ae4` | 2026-07-23 | overlay-docs | 0% | n/a | docs: record cloud desired state |
| `6fd5d7fd73bd` | 2026-07-23 | overlay-docs | 0% | n/a | docs: design journal server parity |
| `9a2bcb090b30` | 2026-07-23 | overlay-docs | 0% | n/a | docs: record journal cloud parity |
| `0e5319a06740` | 2026-07-24 | overlay-docs | 0% | n/a | docs(agrolink): record scoped edge execution |
| `b4cb078cb40d` | 2026-07-24 | overlay-docs | 0% | n/a | docs(agrolink): refresh scoped cloud design |
| `18d7a19759aa` | 2026-07-24 | overlay-docs | 0% | n/a | docs(agrolink): record scoped cloud parity |
| `d3f47d8dc468` | 2026-07-24 | overlay-docs | 0% | n/a | docs(agrolink): plan zone convergence parity |
| `5b7b8acf5b35` | 2026-07-24 | overlay-docs | 0% | n/a | docs(agrolink): record zone parity evidence |
| `e01e715b253f` | 2026-07-24 | overlay-docs | 0% | n/a | docs(agrolink): design schedule calibration parity |
| `219ebfc11450` | 2026-07-24 | overlay-docs | 0% | n/a | docs(agrolink): plan schedule calibration parity |
| `68d68cd58c7e` | 2026-07-24 | overlay-docs | 0% | n/a | docs(agrolink): record irrigation config parity |
| `0e3b87fb0258` | 2026-07-24 | overlay-docs | 0% | n/a | docs(agrolink): design device parity |
| `3b863afbe199` | 2026-07-24 | overlay-docs | 0% | n/a | docs(agrolink): plan device parity |
| `3af69b68c2ec` | 2026-07-25 | overlay-docs | 0% | n/a | docs(agrolink): record device parity |
| `d1db6fdae31f` | 2026-07-25 | overlay-docs | 0% | n/a | docs: plan history analysis settings parity |
| `a339184e8423` | 2026-07-25 | overlay-docs | 0% | n/a | docs(agrolink): record history settings parity |
| `9335297ea539` | 2026-07-25 | overlay-docs | 0% | n/a | docs(agrolink): plan account workflow parity |
| `022c04042ec7` | 2026-07-25 | overlay-docs | 0% | n/a | docs: record account workflow parity |
| `0803eccbb3c7` | 2026-07-25 | overlay-docs | 0% | n/a | docs: plan durable history batch cutover |
| `cdd45baf3e3a` | 2026-07-25 | overlay-docs | 0% | n/a | docs: record durable history parity |
| `0c742a524847` | 2026-07-25 | overlay-docs | 0% | n/a | docs: design installation-bound recovery |
| `12fc522f8907` | 2026-07-25 | overlay-docs | 0% | n/a | docs: record installation recovery evidence |
| `7d6be688005a` | 2026-07-25 | overlay-docs | 0% | n/a | docs: close AgroLink parity program |
| `38afecc352e2` | 2026-07-30 | overlay-docs | 0% | n/a | docs: record AgroLink review remediation |
| `4aa13b2b68c6` | 2026-08-03 | overlay-docs | 0% | n/a | docs: reconcile parity matrix inventory + grant-gap and dedup traceability |
| `ec89351ab356` | 2026-08-04 | overlay-docs | 0% | n/a | docs(parity): record the scope-enforcement remediation's deliberate boundaries (R6) |
| `7cbba825646a` | 2026-08-04 | overlay-docs | 0% | n/a | docs: GUI parity S0 implementation plan (ui-core, vendor gates, gateway context) |
| `47f9afafde75` | 2026-08-04 | overlay-docs | 0% | n/a | docs: seed AgroLink GUI-parity matrix (S0) |
| `4fdb12eecd64` | 2026-08-05 | overlay-docs | 0% | n/a | docs: GUI parity S1 implementation plan (zones/schedules/calibration cohesion) |
| `c7342362d2a4` | 2026-08-05 | overlay-docs | 0% | n/a | docs: matrix S1 rows — zones/schedules/calibration partial pending walkthrough |
| `b8f990e33598` | 2026-08-05 | overlay-docs | 0% | n/a | docs: GUI parity S2 implementation plan (devices/valve, amended per Opus pre-execution review) |
| `aa66c60d413c` | 2026-08-05 | overlay-docs | 0% | n/a | docs(contract): VALVE_COMMAND action enum gains OPEN_FOR_DURATION (S2) |
| `d37cba4599c1` | 2026-08-05 | overlay-docs | 0% | n/a | docs: S2 plan T9 rewire after T3 identity reshape (operable prop, ownership not role-null) |
| `6ad22f18b485` | 2026-08-05 | overlay-docs | 0% | n/a | docs: matrix S2 rows — devices/valve control partial pending walkthrough |
| `dd802d5feb3a` | 2026-08-05 | overlay-docs | 0% | n/a | docs: matrix review fixes — weather-row precision, T8 ledger gap, cloud line counts |
| `719b5e4e283a` | 2026-08-05 | overlay-docs | 0% | n/a | docs: matrix ledger — MQTT hardcode, edge action fence, deploy-status correction |
| `d32b8f9c080b` | 2026-08-06 | overlay-docs | 0% | n/a | docs: matrix S3 rows — journal capture partial pending walkthrough |
| `971aa97c04cc` | 2026-08-06 | overlay-docs | 0% | n/a | docs: S3 journal-capture implementation plan (as executed) |
| `d0daa274c04f` | 2026-08-07 | overlay-docs | 0% | n/a | docs: S4 history/analysis plan (as executed through T10) |
| `b11cb91b82e0` | 2026-08-11 | overlay-docs | 0% | n/a | docs: S6 shell/navigation parity plan (11 tasks, 75 steps) |
| `ab4485e4f423` | 2026-08-11 | overlay-docs | 0% | n/a | docs: S6 plan revision — three guards that could not fail, two answered gates, seven corrections |
| `ba7a02b955d8` | 2026-08-11 | overlay-docs | 0% | n/a | docs: matrix journal rows — the V1/V2 fork, and what the fork does not carry |
| `e44ac4e241f0` | 2026-08-12 | overlay-docs | 0% | n/a | docs: matrix S6 rows — the shell ships; nineteen findings ledgered |
| `4bbe08a1b985` | 2026-08-12 | overlay-docs | 0% | n/a | docs: fix matrix ledger item 11 — WritableOnly.tsx was deleted, not orphaned |
| `8dfc6b475d43` | 2026-08-12 | overlay-docs | 0% | n/a | docs: write-only scoping + two-option device add design spec |
| `35836156f58e` | 2026-08-12 | overlay-docs | 0% | n/a | docs: write-only scoping cloud implementation plan |
| `a6f103554756` | 2026-08-12 | overlay-docs | 0% | n/a | docs: write-only scoping edge implementation plan |
| `65aec22b32dd` | 2026-08-12 | overlay-docs | 0% | n/a | docs: spec v2 — zoneUuid command contract, vocab and unassigned-delete decisions, P8 scope |
| `e739e336a3cf` | 2026-08-12 | overlay-docs | 0% | n/a | docs: edge plan v2 — REGISTER_DEVICE zoneUuid applier and unassigned-delete carve-out |
| `61ba81cc529c` | 2026-08-12 | overlay-docs | 0% | n/a | docs: edge plan v3 — unclaimed rows excluded from account-wide device list |
| `00b4e84eba69` | 2026-08-12 | overlay-docs | 0% | n/a | docs: codex execution brief for write-only scoping rework |
| `7335bebe7228` | 2026-08-13 | overlay-docs | 0% | n/a | docs: adjudicated branch findings ledger from five reviews |
| `8475c36b79c2` | 2026-08-13 | overlay-docs | 0% | n/a | docs: ledger v2 — deployment and live-state findings D1-D8 |
| `1b98a437c4eb` | 2026-08-13 | overlay-docs | 0% | n/a | docs: agrolink fix-wave implementation plan |
| `e6ad2eaefcc5` | 2026-08-13 | overlay-docs | 0% | n/a | docs: codex execution brief for the agrolink fix wave |
| `b01ba7e7f084` | 2026-08-13 | overlay-docs | 0% | n/a | test: full cloud sweep with preserved artifacts |
| `2e47ab5bff81` | 2026-08-13 | overlay-docs | 0% | n/a | docs: record agrolink fix-wave execution |
| `e7a49b97c6bc` | 2026-08-13 | overlay-docs | 0% | n/a | docs: ledger v3 — fix-wave execution review, rounds R1-R14 |
| `d15172aa5c58` | 2026-08-13 | overlay-docs | 0% | n/a | docs: record AgroLink Round 2 execution |
| `b027513ecaa2` | 2026-08-13 | overlay-docs | 0% | n/a | docs: ledger v4 — round-2 review, R8 fail, N1-N5, residual-red dispositions |
| `74fa2655a0bf` | 2026-08-13 | overlay-docs | 0% | n/a | docs: correct round-two execution evidence |
| `ba811185f4cd` | 2026-08-13 | overlay-docs | 0% | n/a | docs: record AgroLink Round 3 execution |
| `22b7ced132bf` | 2026-08-13 | overlay-docs | 0% | n/a | docs: ledger v5 — round-3 close-out, MERGE-READY, N-A deploy gate added |
| `2986f37349c9` | 2026-08-13 | overlay-docs | 0% | n/a | docs: ledger v5.1 — rollout law restated for the branch-resident model |
| `a2162460be4d` | 2026-08-13 | overlay-docs | 85% | n/a | fix(sdi12): SET_SDI12_IDENTIFY in the commands contract enum |
| `8a173145a7ed` | 2026-08-13 | overlay-docs | 67% | n/a | fix(sdi12): DeviceDesiredState carries DRAGINO_SDI12 + sdi12_probe_profile |
| `a9acf89c122b` | 2026-07-15 | superseded | 100% | n/a | fix: share correctly ordered gateway identity heal |
| `dd9da0871fdb` | 2026-07-15 | superseded | 100% | n/a | feat: add live gateway identity state machine |
| `ddee9f568135` | 2026-07-15 | superseded | 100% | n/a | feat: supervise live gateway identity on OpenWrt |
| `f07c3e087124` | 2026-07-15 | superseded | 92% | n/a | fix: pause identity-sensitive flows until restart |
| `04c8eee2535d` | 2026-07-15 | superseded | 94% | n/a | feat: expose pending gateway restart status |
| `3fc18e70c1de` | 2026-07-15 | superseded | 96% | n/a | feat: warn before gateway identity restart |
| `675b5faf1249` | 2026-07-15 | superseded | 100% | n/a | docs: document live gateway identity transitions |
| `210ca963ce55` | 2026-07-16 | superseded | 100% | n/a | refactor(api): export the shared axios instance for feature modules |
| `6ede2ff23278` | 2026-07-16 | superseded | 92% | n/a | feat(journal): integrate mobile capture entry points |
| `af513608b259` | 2026-07-16 | superseded | 99% | n/a | i18n(history): translate all shipped locales |
| `586a5cb7e5d7` | 2026-07-16 | superseded | 96% | n/a | fix: address live identity review feedback |
| `853cc494fb73` | 2026-07-17 | superseded | 96% | n/a | feat(sync-protocol-state): add canonicalization codecs and path primitives |
| `2ebb3ad7a728` | 2026-07-17 | superseded | 99% | n/a | feat(sync-protocol-state): add activity SQLite ledger and four-root locks |
| `2479af46b0ec` | 2026-07-17 | superseded | 96% | n/a | feat(sync-protocol-state): add four-root initialization |
| `6a8c4b665bcb` | 2026-07-17 | superseded | 98% | n/a | fix(sync-protocol-state): enforce bidirectional generation/witness set equality |
| `7e839727860c` | 2026-07-17 | superseded | 97% | n/a | fix(sync-protocol-state): parse the real format-2 deployment-state envelope |
| `bc19f401a110` | 2026-07-17 | superseded | 99% | n/a | fix(sync-protocol-state): fail closed on pre-existing dir modes and activity.sqlite mode |
| `b8e146d2b17c` | 2026-07-18 | superseded | 96% | n/a | chore(sync-protocol-state): re-mirror fix-wave module changes to bcm2709 |
| `6e49e3732f93` | 2026-07-18 | superseded | 100% | n/a | chore(sync-protocol-state): mirror witnessed/checkpoint slice to bcm2709 profile |
| `e400b372be9f` | 2026-07-18 | superseded | 100% | n/a | fix(sync-protocol-state): review minors — synchronous-at-open, recoveryPhase, factory anchor codec |
| `5970b1bdcafd` | 2026-07-18 | superseded | 100% | n/a | feat(sync-protocol-state): add durable activity append discipline |
| `7c59e36f24df` | 2026-07-18 | superseded | 98% | n/a | feat(sync-protocol-state): publish external activity-head witness per append |
| `be8bc8a6eb0e` | 2026-07-18 | superseded | 100% | n/a | refactor(sync-protocol-state): add witnessed operation registry and one-use capability |
| `82af1a8a1a65` | 2026-07-18 | superseded | 100% | n/a | feat(sync-protocol-state): checkpoint receipts, prune, ceilings, bounded verification |
| `e4a54b883ef1` | 2026-07-18 | superseded | 98% | n/a | test(sync-protocol-state): million-activity capacity + crash boundary matrix |
| `3690d6e13371` | 2026-07-19 | superseded | 99% | n/a | fix(journal): make batch retries idempotent |
| `918d5d037fd2` | 2026-07-19 | superseded | 99% | n/a | fix(journal): close Phase 3 carry-forward review |
| `022f804889c5` | 2026-07-19 | superseded | 92% | n/a | feat(journal): land P4 as catalog v2 via incremental delta migration |
| `02cb8e4923fe` | 2026-07-19 | superseded | 95% | n/a | feat(journal): desktop entry table with keyset pagination and filter-scoped exports |
| `dd829fc85a58` | 2026-07-19 | superseded | 98% | n/a | feat(journal): persisted-draft discard contract + Needs completion queue |
| `fcfb232408fc` | 2026-07-19 | superseded | 96% | n/a | feat(journal): desktop detail read-back and full-record correction (Slice 2 Task 30) |
| `4cff0b5a3d42` | 2026-07-19 | superseded | 98% | n/a | feat(journal): locale completion + feed mirror + branding test (Slice 2 Task 34) |
| `4cbc6f39c479` | 2026-07-19 | superseded | 100% | n/a | chore: synchronize protocol-state profile mirror |
| `f8119940d046` | 2026-07-19 | superseded | 99% | n/a | feat(sync-protocol-state): implement deployment protocol verbs |
| `3bd28aa45c17` | 2026-07-19 | superseded | 100% | n/a | Revert "fix(chirpstack-helper): fence-checked create rollback and explicit JoinEUI restore" |
| `7783cfbc5b41` | 2026-07-19 | superseded | 99% | n/a | Revert "fix(device-writer): consume async db contract, fail closed on schema drift" |
| `27f2bced61c1` | 2026-07-20 | superseded | 97% | n/a | feat(journal): desktop Log activity capture entry point |
| `045b853ebfc0` | 2026-07-20 | superseded | 92% | n/a | feat(journal): Slice BC - activity-scoped Quick + plot-static context (D2/D3/D4) |
| `b38cffca1e59` | 2026-07-20 | superseded | 100% | n/a | feat(journal): Slice D phase 2 - edge crop-cycle lifecycle + live resolution (D-0/D-2) |
| `00b9df56c141` | 2026-07-21 | superseded | 98% | n/a | fix(journal): Slice D hardening + login balken + export hang (post-live-UX) |
| `be363f891b12` | 2026-07-21 | superseded | 91% | n/a | feat(journal): Slice F - agronomy adds (BBCH, weather-at-application, tank-mix) + Full field completeness |
| `270db104586a` | 2026-07-22 | superseded | 100% | n/a | fix(journal): correct full_record@6 drift in bundled seed DBs + add row-content gate |
| `14b612703e42` | 2026-07-23 | superseded | 99% | n/a | feat(journal): operation-level field/requirement/product scoping + comment + free-text device (catalog v10) |
| `4eb055229b31` | 2026-07-23 | superseded | 92% | n/a | feat(auth): complete scoped access phase A |
| `ace19a13fb67` | 2026-07-23 | superseded | 95% | n/a | feat(api): scoped device provisioning (R2, R5) |
| `9f17c6e2ae07` | 2026-07-24 | superseded | 97% | n/a | fix(flows): preserve generator formatting |
| `853294df16e9` | 2026-07-24 | superseded | 92% | n/a | feat(gui): role/scope-gated mutation controls |
| `974d9085be1f` | 2026-07-24 | superseded | 99% | n/a | feat(gui): admin user + grant management screens |
| `0303e68ed627` | 2026-07-24 | superseded | 92% | n/a | feat(contract): govern scoped access commands |
| `95c6f5c837ec` | 2026-07-24 | superseded | 98% | n/a | feat(sync): apply scoped access commands |
| `7e30e6a49f49` | 2026-07-25 | superseded | 93% | n/a | feat: promote durable history batches |
| `45e2a57e9868` | 2026-07-25 | superseded | 100% | n/a | feat: stage guarded installation recovery |
| `6800a4218daa` | 2026-08-03 | superseded | 94% | n/a | fix(sync): scoped weather zone edits mirror to weather_station_zone_state (E1) |
| `034f4dbc01fc` | 2026-08-03 | superseded | 93% | n/a | fix(actuation): require an actor on scoped physical device commands (E3, Critical) |
| `0913a6902cd1` | 2026-08-04 | superseded | 92% | n/a | fix(actuation): close the GUI STREGA advanced chain's scope gap (X2) |
| `b663c82a6e9b` | 2026-08-04 | superseded | 98% | n/a | feat: ui-core glass surface, button and chip primitives |
| `00226ba3e8ad` | 2026-08-04 | superseded | 95% | n/a | feat: ui-core modal, banner and form-field primitives |
| `7f817d0c32d0` | 2026-08-04 | superseded | 100% | n/a | feat: ui-core table-shell and empty-state primitives + barrel |
| `a8ef3bd34ae9` | 2026-08-04 | superseded | 95% | n/a | feat: edge adopts ui-core tokens/primitives.css (bundle-parity gated) |
| `6dec8fcbaf94` | 2026-08-04 | superseded | 100% | n/a | docs: attribute danger-fg allowlist atom to both Chip.tsx and Banner.tsx |
| `1cea8c979bca` | 2026-08-05 | superseded | 100% | n/a | feat: farming dashboard empty state on ui-core EmptyState/Button |
| `65934c6dbc99` | 2026-08-05 | superseded | 100% | n/a | test: cover farming dashboard empty-state canWrite guard at runtime |
| `79fcecbc532a` | 2026-08-06 | superseded | 97% | n/a | fix(ui-core): add --on-primary token pair, fix illegible white-on-primary text |
| `6e6c5d7c09f3` | 2026-08-06 | superseded | 100% | n/a | fix(ui-core): add info tone, stop spending warn on loading states |
| `7d37af9fdaac` | 2026-08-06 | superseded | 100% | n/a | fix(ui-core): darken --text-tertiary/--soil-moist, add --field-border |
| `57771b500dea` | 2026-08-09 | superseded | 97% | n/a | fix(journal): preserve edge journal authority |
| `4dc775b52491` | 2026-08-09 | superseded | 98% | n/a | feat(journal): replicate cloud-primary journal state |
| `68e4af3c0043` | 2026-08-10 | superseded | 100% | n/a | fix(ui-core): make Modal scrollable and viewport-bounded |
| `0bdf1d3b9e03` | 2026-08-12 | superseded | 100% | n/a | fix(ui-core): translucent modal scrim, color-scheme for native pickers, fence --danger-fg pairings |
| `bf1a02a995e1` | 2026-08-12 | superseded | 93% | n/a | fix(gui): read-only users keep Settings — language, theme and units are not write authorities |
| `a978bc29f25c` | 2026-08-12 | superseded | 93% | n/a | fix(gui): tell read-only users why, once per surface instead of eighteen silences |
| `9a7b87cb2c47` | 2026-08-12 | superseded | 93% | n/a | fix: stop the read-only banner from showing to every user on first paint |
| `c9a8458f1da9` | 2026-08-13 | superseded | 91% | n/a | feat(scope): assign only unassigned devices and return a naming 409 on conflict |
| `a1f6141f2e62` | 2026-08-13 | superseded | 91% | n/a | feat(gui): render every zone and device on the farming dashboard |
| `479c5f5f7053` | 2026-08-13 | superseded | 100% | n/a | feat(gui): render every journal plot and zone for enabled accounts |
| `e076da175d74` | 2026-08-13 | superseded | 98% | n/a | feat(gui): render every history zone for enabled accounts |
| `fcf70de41f8d` | 2026-08-13 | superseded | 98% | n/a | feat(gui): one two-tab zone device modal for assign-existing and register-new |
| `464a1cb580ef` | 2026-08-13 | superseded | 100% | n/a | refactor(scope): retire the read-filter API and ratchet against its return |
| `09bcf11c081d` | 2026-08-13 | superseded | 96% | n/a | feat(scope): let any write role delete an unassigned device |
| `185f803f0060` | 2026-08-13 | superseded | 100% | n/a | fix(gui): keep zone weather stations on their cards |
| `ca32063450d3` | 2026-08-13 | superseded | 100% | n/a | fix(gui): keep admin navigation and journal reads available |
| `9f435714bf4d` | 2026-08-13 | superseded | 100% | n/a | fix(i18n): translate the AppKey field in all seven locales |
| `2d1add36ac41` | 2026-08-13 | superseded | 100% | n/a | ci: restore GUI workflow working directory |
| `1c47306eb468` | 2026-08-13 | superseded | 97% | n/a | feat(sdi12): dragino sdi-12 codec + verifier |
| `d2ad9cc65f64` | 2026-08-13 | superseded | 90% | n/a | feat(sdi12): probe-profile normalize module with registry + transforms |
| `6ffc7a07ddb1` | 2026-08-13 | superseded | 93% | n/a | fix: fence cloud device claims in flag-off mode |
| `d4364f6725fc` | 2026-08-13 | superseded | 97% | n/a | fix: resolve register claims by stable user identity |
| `6cc469e2f024` | 2026-08-13 | superseded | 91% | n/a | feat(sdi12): probe-profile listing + device config endpoints |
| `4c67b566772a` | 2026-08-13 | superseded | 94% | n/a | feat(sdi12): settings modal, dashboard/zone wiring, history soil-card eligibility |
| `f471545f17a2` | 2026-08-13 | superseded | 91% | n/a | feat(sdi12): golden-vector round-trip + wire device-integration into CI |
| `853c1b358433` | 2026-08-13 | superseded | 100% | n/a | fix(sdi12): realign config scope wires and cover denial |
| `6e21d1046b7b` | 2026-08-19 | superseded | 99% | n/a | feat(sdi12): reassembly state machine for multi-segment uplinks |
| `30c42381d1bb` | 2026-08-29 | superseded | 96% | n/a | feat(sdi12): add durable commissioning state machine |
