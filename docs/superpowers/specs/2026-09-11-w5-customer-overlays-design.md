# W5 — customer branches as overlays on main

Status: design, not executed. No branch was cut, no host was touched.
Baselines: osi-os `main` = `2c9ef4c34`, osi-server `main` = `3b0bad45`.
Predecessor: `.superpowers/sdd/stabilization-plan-2026-09-10.md` (wave 3.5).
Companion inventory: `docs/superpowers/reviews/2026-09-11-w5-edge-overlay-inventory.md`.

## What this wave can deliver, and what it cannot

The premise of W5 was that waves 3 and 4 had absorbed the customer lines, so
Bovey and AgroLink could be re-cut as thin overlays: `main` plus a handful of
branding commits. Measured against the two mains, that premise holds on the
edge and **fails on the cloud**.

**Edge, both customers: the premise holds.** Of the 31 commits on
`Valve-focused` that `main` does not carry by patch-id, five are Bovey
branding, thirteen are plan documents, five are already on `main` in reshaped
form, and eight are leftovers of which only four carry any code residue at all
(203, 87, 12 and 9 lines). `customer/bovey` on the edge is a five-commit
overlay. AgroLink's edge line is larger and messier but the same shape: 20
branding-tagged commits against 135 plan documents and 93 commits already
absorbed.

**Cloud, Bovey: the premise fails.** `feat/bovey-cloud-parity` has 93 commits
`main` does not carry, and **not one of them measures as present on `main`**
by the content probe. What `main` did take from that line is the persistence
floor — `V2026_08_24_001__valve_schedules`, the three
`V2026_08_26_00N__valve_*_mirror` migrations, the `ValveSchedule` /
`ValveSettings` / `ValveRuntime` / `ValveActuation` entities and their sync
appliers (the four commits reading 67–77%). Everything above that floor is
still Bovey-only: `ValveController` and the valve REST surface, the
`recent-irrigations` endpoint and its `valve_state_transitions` table, the
entire React valve UI (`ValveTile`, settings/service/schedule dialogs,
`IrrigationOutcomesPanel`, the all-valves overview), the realtime push for
settings/runtime/actuations, the honest-ACK classification work, and the
seven-locale i18n programme with its `localeParity` gate.

That is generic product work sitting on a customer branch. It is not overlay
content and it should not be treated as such. **Recommendation:** `customer/bovey`
on the cloud is a fat branch for now, and porting the Bovey cloud valve surface
to `main` is a wave of its own (call it W6), sized somewhere near wave 3. The
alternative — declaring the valve surface "Bovey-specific" — would be a
decision to keep two cloud products, and nobody has made that decision.

**Cloud, AgroLink: partly.** 248 commits `main` does not carry by patch-id; 53
measure as present, 36 partial, 111 absent or mostly absent. The migration
half is fully reconciled (below); the application half is not surveyed at this
depth and needs the same treatment the edge line got.

## Overlay content, per customer and repo

### Bovey — osi-os edge (`customer/bovey`)

Five commits on `Valve-focused`, 34 files, GUI only. Nothing under `conf/`,
no migration, no flow change. Cherry-pick in this order:

| commit | what |
|---|---|
| `7ee2c8c16955` | wordmark on login and header, Bovey palette |
| `3c27cf453d8a` | GUI states only Bovey — drop the OSI OS name, version and Alpha tag |
| `f8ecff490430` | brushed-aluminium light header, "Bovey Cloud" rename |
| `e59558f6ff47` | brushed-metal chrome; header shows only the welcome line |
| `b3485e8b7aee` | subtler brush streaks (texture alpha 0.16/0.14 → 0.08/0.07) |

The same five exist as `origin/feat/bovey-branding` (`ab511d7cd`..`abeb292a7`),
cut from an older `main`. Prefer the `Valve-focused` copies: they are the ones
that were deployed to `bovey-rp4-01`.

What the overlay actually contains:

- **Identity.** `src/components/BoveyLogo.tsx` (the official vector from
  boveysa.ch, `fill="currentColor"` so it tracks theme text colour),
  `public/favicon.png`, `index.html` title. `src/assets/osi_logo.png` is
  deleted.
- **Palette and chrome.** `src/index.css` — primary/focus `#055E92`, hover
  `#04486F`, header `#1D1D1B`, danger `#AB2129`, dark-theme accent `#4FAEE3`;
  the `.brushed-header` and `.metal-emboss` classes and their two inline-SVG
  `feTurbulence` streak layers.
- **Copy.** `dashboard.json` and `accountLink.json` in all seven locales, plus
  `en/devices.json`: "OSI Server" → "Bovey Cloud" everywhere, product names
  removed from headings.
- **Component touch-ups** carrying the palette into eleven farming/history
  components that had hardcoded colours.
- **`tests/boveyBranding.test.ts`**, which pins logo usage, palette values and
  favicon so a future `main` merge cannot silently un-brand the build.

### Bovey — osi-server cloud (`customer/bovey`)

Two layers, and they must not be conflated.

**Layer 1, the true overlay:** `origin/feat/bovey-branding`, five commits
(`60f9cc2d`..`be5dbc58`), 31 files, mirroring the edge set —
`frontend/src/components/BoveyLogo.tsx`, `frontend/public/favicon.svg`,
`frontend/src/index.css`, `auth.json` + `dashboard.json` in seven locales,
`frontend/tests/boveyBranding.test.ts`, and the same component touch-ups.

**Layer 2, not overlay content:** the remaining 88 commits of
`feat/bovey-cloud-parity` (up to `14c916c9`), plus
`feat/bovey-websocket-transport` on top. This is the valve product surface
described above. It rides on `customer/bovey` until W6 ports it to `main`.

`feat/bovey-websocket-transport` is now mostly redundant: its baseline,
`feat/websocket-responsiveness-overhaul`, merged to `main` as PR #91. What
remains branch-side is the Bovey-specific wiring of that transport to the
valve events (`ValveSettingsChangedEvent`, `ValveRuntimeChangedEvent`,
`ValveActuationArchivedEvent`, `ScheduleMirrorChangedEvent` and their
subscription authorizers) — which travels with layer 2, not with branding.

Note the deploy gate that now applies to this host: post-#91 `main` refuses to
render compose unless `WEBSOCKET_ALLOWED_ORIGIN_PATTERNS` is set in
`docker/.env`. Set it for `https://bovey.cloud` before the cutover, not during.

`mobile/android-bovey/` (the WebView wrapper, `6bba1545`/`28bf902c`/`14c916c9`)
is customer-specific by construction and belongs on `customer/bovey`. Its
release keystore stays outside the repo at `~/.android/bovey-release.jks`.

### AgroLink — osi-os edge (`customer/agrolink`)

The overlay is the Agroscope identity work: the Balken header (Variant A,
Agroscope red on white, Noto Sans), the AgroLink wordmark and login card, the
red-square favicon, the liquid-glass chrome, and the `.design-sync/` project.
Twenty commits carry the tag, and **the tag over-reaches** — it is keyword
driven, so it also catches `66210d0b5dfd` (the Agroscope journal activity
vocabulary, catalog v9, which is product content) and `6d16d64483e0` (a
dark-theme `FormField.tsx` readability fix, which is a plain bug fix that
belongs on `main`). Re-read all twenty before cherry-picking; the inventory
lists them.

There is no `feat/agrolink-branding` branch in either repository. The memory
index claims one was pushed; `git branch -a` in both repos finds nothing by
that name. Either it was deleted or the note is wrong — treat `origin/AgroLink`
as the only source for AgroLink branding, and flag this to Phil.

`deploy/agrolink-websocket-edge` is `AgroLink` plus the edge half of the
websocket work, and is superseded the same way the cloud one is.

### AgroLink — osi-server cloud (`customer/agrolink`)

Not surveyed to overlay depth in this wave. `origin/AgroLink` (`7d182f9d`) has
248 commits off `main`, of which 53 already measure as present. Its migration
lineage *is* fully reconciled — see below — which is the part that blocks a
deploy. The frontend identity work (Swiss-cross login retained by ruling D6 of
the GUI-parity spec, Agroscope chrome, `ui-core` vendoring) is the overlay
candidate set; establishing it precisely is the first task of the AgroLink
half of this wave.

### Locale policy — binding, and the two repos disagree

Cloud Luganda is an English mirror, enforced by
`frontend/src/i18n/__tests__/localeParity.test.ts`: `lg == en` except the 367
keys frozen in `lgLegacyAllowlist.json`. New cloud keys ship in English.

Edge Luganda is **human-translated** and is a Uganda ship gate. An edge `lg`
value is somebody's work product, not a placeholder. When porting copy between
the repos: on the edge, only *add* keys (in English, flagged for the native
pass) and never overwrite an existing non-English value; run
`git show <base>:<file>` first. On 2026-08-27 a fix round told to "align edge
`lg` to the cloud wording" overwrote the human "Obuweereza" with "Service
commands"; it was restored in `a70a971f`. Do not repeat it.

Phil's 2026-09-11 ruling stands: Luganda is roadmap, no priority, #78 stays as
merged, no action in this wave.

## What is now redundant with main

| was | evidence | verdict |
|---|---|---|
| `Valve-focused` valve sync families (`UPSERT_VALVE_SETTINGS`, `VALVE_ACTUATION_ARCHIVED` emit, observed weekly runs, actuator_log percentage) | `05a4814f4713` 94%, `bb3c7fba5259` 97%, `c7d94cb60315` 94%, `b8834291df1c` 95% | on `main`; do not re-port |
| `Valve-focused` two-tab zone device modal | `ab643cf982b4` 92% | on `main` |
| Bovey cloud persistence floor | `V2026_08_24_001`, `V2026_08_26_001..003` byte-identical between `feat/bovey-cloud-parity` and `main`; `ValveSchedule`/`ValveSettings`/`ValveRuntime`/`ValveActuation` entities and appliers present | on `main` |
| AgroLink cloud migrations | 13 of 15 byte-identical to their renumbered `main` counterparts (sha256-verified pairwise) | on `main` |
| `feat/websocket-responsiveness-overhaul` | merged as PR #91 | on `main`; the four `*-websocket-*` branches keep only their customer wiring |
| `Valve-focused` plan/spec documents (13) | `main` never took them and does not want them | stay on the customer branch or are dropped |

## Branch construction

Two new branches per repo, cut from `main`, never from a customer branch.

```sh
git switch -c customer/bovey origin/main
git cherry-pick 7ee2c8c16955 3c27cf453d8a f8ecff490430 e59558f6ff47 b3485e8b7aee
# edge: expect a conflict only in en/devices.json (the one file the branding
# commits share with later main work)
```

Cloud `customer/bovey` is cut the same way from `origin/main`, then takes
`origin/feat/bovey-branding`'s five commits, then merges
`origin/feat/bovey-cloud-parity` and `origin/feat/bovey-websocket-transport`
as layer 2. That merge is where the real work is: those branches fork from a
`main` 469 commits behind, so this is a rebase-or-merge exercise across wave-3
and wave-4 ports of the same files, not a cherry-pick.

`customer/agrolink` follows once its overlay set is established.

**Archiving the old branches.** Do not delete them. Retag and keep:

```sh
git tag archive/valve-focused-20260911 origin/Valve-focused
git tag archive/agrolink-20260911      origin/AgroLink
git push origin archive/valve-focused-20260911 archive/agrolink-20260911
```

then delete the branch refs only after `customer/*` has been deployed to the
corresponding host and verified. The tags keep `git cherry` and the inventory
above reproducible; the existing worktrees
(`.claude/worktrees/valve-focused`, `osi-os-agrolink`,
`.worktrees/bovey-cloud-parity`) are left untouched either way — wave 3.5's
rule, and several of them carry uncommitted work.

The one branch that must NOT be archived yet is
`origin/feat/bovey-cloud-parity`: it is the source for W6 and for the running
`:bovey-local` image.

## Cutover, per live host

Every host below is gated on Phil's explicit go **for that host**, in the turn
the work happens. A loaded key or a standing plan is not consent. Order is
cloud before edge, per the rollout law in the 2026-08-13 AgroLink review: a new
edge against an old cloud terminally NACKs physical valve actions.

### Step 0 — the census, for every target

Nothing below is safe to run without it. Read-only, on each target database:

```sql
SELECT version, description, checksum, success
FROM flyway_schema_history ORDER BY installed_rank;
```

or `scripts/verify-flyway-target.sh`, which does the comparison and exits
non-zero if the target is not in the state a reconciliation block assumes.
Record the output before touching anything. Every expected-state claim below is
derived from git, and git tells you what a branch *contains*, not what a
database *applied*.

### Bovey cloud (`-p bovey` compose project, agro-link.ch)

Blocker: the Bovey database has `2026.08.25.001` applied with description
`valve state transitions`; `main`'s tree has the same version as
`sentek channel layout`, different bytes. Flyway validation fails on the first
`main` deploy.

Prerequisite, delivered by osi-server PR `feat/w5-cloud-prereqs`:
`V2026_09_19_001__valve_state_transitions.sql`, the Bovey file byte-for-byte
(sha256 `ca0b9149d5dec04fa61b7571182d70595222e28f3a84e8a74eae21e38e783cfa`)
under a version above `main`'s ceiling of `2026.09.18.001`, plus block (c) of
`docs/operations/flyway-lineage-reconciliation.sql`.

1. Census (step 0). Confirm `2026.08.25.001 / valve state transitions` is
   applied and that the ceiling is `2026.08.26.003`.
2. Back up the database. Rehearse steps 3–5 on the restored copy.
3. Run block (c): one guarded `UPDATE`, renaming the applied row to
   `2026.09.19.001`. Checksum untouched — the bytes never changed.
4. Fill the hole: `2026.08.25.001 sentek channel layout` is now unapplied and
   below the ceiling, and this repo does not turn `out-of-order` on. Apply that
   migration by hand and insert its history row with Flyway's checksum for the
   file.
5. Re-run `verify-flyway-target.sh`. Green, or stop.
6. Set `WEBSOCKET_ALLOWED_ORIGIN_PATTERNS` in `docker/.env` (post-#91 compose
   refuses to render without it).
7. Deploy by the real path: the bundle flow for this host
   (`git bundle create` → `scp` → `git fetch <bundle> refs/heads/X:refs/heads/X`
   → `merge --ff-only`), then
   `docker compose -f docker-compose.yml -f docker-compose.dev-build.yml -f docker-compose.bovey.yml -p bovey build backend`
   and `up -d --no-deps backend --force-recreate`. Use `--force-recreate`: a
   `build` that completed in a dropped SSH session leaves `up -d` reporting
   "Running" without swapping the image.

`docker-compose.bovey.yml` is **not in git** — it is host-local in
`/home/rocky/docker/bovey/osi-server/docker/`, deliberately untracked so branch
switches cannot clobber it. It pins the image tag to `:bovey-local` so
AgroLink's `:dev-local` cannot overwrite it. Before any cutover, copy it off
the box and record its contents somewhere recoverable. Losing it silently
merges the two customers onto one image tag.

### AgroLink cloud (`agro-link.ch`, the `:dev-local` project)

Harder than Bovey, and not a script. Blocks (d) and (e) of the reconciliation
SQL cover the eleven proven 1:1 renames and the one drifted migration; three
problems survive them, and all three land in the same window:

1. **Four applied rows with no counterpart.** AgroLink applied
   `2026.07.24.001..004`. `main` consolidated three of them into one
   `V2026_09_14_001__desired_state_capability_extension.sql` and never took
   `.002`'s `zone_irrigation_calibrations` table or `.003`'s nullability change
   at all — `main`'s `V2026_09_13_001` creates a *different* table,
   `zone_irrigation_calibration_mirror`. Flyway rejects applied-but-unresolved
   rows, so the four must be deleted and `2026.09.14.001` recorded as applied
   without running it (its columns already exist; running it raises
   `duplicate column`). `zone_irrigation_calibrations` is then an orphan table.
   Leave it, and write down that it is there.
2. **Four migrations below the post-rename ceiling.** Block (d) lifts the
   ceiling to `2026.09.12.004`; `2026.09.03.001..003` (SMS) and
   `2026.09.05.001` (`app_settings`) are then pending below it. Apply and
   record them by hand, in version order.
3. **One drifted checksum.** AgroLink's `scoped_access_mirrors` is thirteen
   lines shorter than `main`'s — it lacks the `app_settings` seed for
   `access.scoped.enabled`. Rename the version, then `flyway repair` to
   realign the checksum. Do not hand-edit `checksum`. Then re-run block (e) to
   land the seed, which needs `app_settings` to exist first.

Rehearse the whole sequence on a restored copy. This is the one target where
"run the SQL and deploy" is the wrong shape.

### Bovey gateway (`bovey-rp4-01`, 100.99.212.115)

Edge ledger 25 in Bovey numbering. `scripts/reconcile-ledger-numbering.js` and
its `deploy.sh` hook (PR #207) are on `main` and handle this without an
operator step: the hook probes the ledger's checksum for the lowest applied
version above the shared 0001–0021 prefix, finds it disagrees with `main`'s
checksum for that same number, and runs reconciliation between
`checkpoint_live_db` and `migrate-cli.js`. A main-numbered gateway falls
straight through.

Expected result, from the fixture proof in
`scripts/reconcile-ledger-numbering.test.js` ("Bovey-lineage fixture"): rows
1–21 are the common prefix, 0022–0024 are already byte-identical to `main` at
the same version, 0025 differs only in a header comment ("Bovey cloud" vs
"cloud"), and **pending after reconciliation is exactly 0026–0053** — `main`'s
whole tail, because this device never ran any AgroLink-derived migration.

Never overwrite `/data/db/farming.db`. Take the backup the deploy script takes
and keep it. Known local hazard: `deploy.sh`'s 5-second post-flip self-check
false-negatives on this Pi 4 (~10 s cold boot) and auto-rolls-back; it has done
so on all three previous Bovey deploys. Expect it, recover with the manual
payload flip, and file the issue this time.

### AgroLink test gateway (`agrolink-test-01`, 100.121.141.64)

Ledger ~47–49 in AgroLink numbering. Same hook, same tool. Expected result,
from the "AgroLink-lineage fixture" proof: all 28 foreign rows classify, the
remap is **not** a uniform offset (+9, +11, −1, −19 blocks interleave
AgroLink's content before and around `main`'s own 0022–0025, covering
0026–0053 contiguously), and **pending after reconciliation is exactly
{0022, 0023, 0024, 0025}** — the valve-control block, which is genuinely new
to this device rather than a numbering artefact.

This corrects the pre-audit estimate of "0050–0053" in the wave-3.5
stabilization plan, and it corrects the "(+)" in the W5 brief: the set is those
four and nothing else.

## Risks

**R1 — the census is not optional and has not been run.** Every expected state
above is derived from branch contents. `verify-flyway-target.sh` exists
precisely because that inference is unreliable. If a census contradicts this
document, the census wins and the plan is re-derived.

**R2 — `docker-compose.bovey.yml` exists in exactly one place on Earth.** It is
untracked on the agro-link.ch box. Lose it and the Bovey deploy starts writing
to `:dev-local`, which is AgroLink's tag on the same host. Copy it off before
step 1 of the Bovey cloud cutover.

**R3 — the Bovey cloud line is 88 commits of unported product.** If
`customer/bovey` is deployed as a fat branch, the Bovey customer is running a
different cloud product from everyone else, and every subsequent `main` merge
into it is a conflict-resolution exercise. This is a cost with a clock on it,
not a stable end state. W6 is the answer.

**R4 — `git cherry` under-reports absorption; the line probe over-reports it.**
Both tools are screens. The inventory's tags are hypotheses. A worker who ports
from a tag without re-deriving the residue against current `main` will port
something twice.

**R5 — the edge `lg` locale is human work product.** Three of the four Bovey
edge follow-up ports touch `lg` files. The failure mode is silent: a diff that
looks like a translation improvement is a deletion of somebody's work.

**R6 — rollout ordering.** New edge against old cloud terminally NACKs every
STREGA and valve physical action (`osi-command-ledger` `physicalActionExpiry`
treats a missing `expires_at` as malformed). Cloud goes first, always.

**R7 — `feat/agrolink-branding` cannot be found.** If it held work not on
`origin/AgroLink`, that work is currently lost. Ask Phil before assuming it is
redundant.

## Rollback

- **Flyway reconciliation.** Every block in
  `docs/operations/flyway-lineage-reconciliation.sql` ships its inverse,
  commented out, immediately below it. Block (e)'s `app_settings` seed has no
  inverse worth running — deleting the row restores "key absent, reads default
  to false", which is what the seed was repairing.
- **Cloud deploy.** The previous image tag is still on the host; `up -d
  --no-deps backend --force-recreate` against the prior tag reverts the
  application. It does **not** revert applied migrations — hence the database
  backup in step 2, which is the only real rollback for the schema.
- **Edge deploy.** `deploy.sh` keeps the prior payload and takes a database
  backup under `/data/db/backups/`; the manual payload flip restores it. The
  ledger reconciliation itself backs up before rewriting and self-checks with
  `verifyHead` afterwards, refusing on any unmapped or ambiguous row.
- **Branches.** The archive tags make every pre-W5 state reachable. Nothing in
  this plan deletes history.

## Execution checklist

Each line is gated on Phil's go for that specific item.

**Prerequisites (no host contact):**

- [ ] osi-server PR `feat/w5-cloud-prereqs` reviewed and merged —
      `V2026_09_19_001__valve_state_transitions.sql` plus reconciliation blocks
      (c), (d), (e).
- [ ] osi-os PR `docs/w5-overlay-inventory` reviewed and merged.
- [ ] Archive tags pushed for `Valve-focused` and `AgroLink`.
- [ ] Copy `docker-compose.bovey.yml` off the agro-link.ch box and store it
      where it can be recovered.

**Branch construction (no host contact):**

- [ ] osi-os `customer/bovey` — five cherry-picks, gates green (typecheck,
      vitest, tsx runner, one build at a time on this workstation).
- [ ] osi-server `customer/bovey` — branding layer, then the
      `feat/bovey-cloud-parity` + `feat/bovey-websocket-transport` merge.
- [ ] AgroLink overlay set established (read the 20 tagged commits; separate
      identity from product), then `customer/agrolink` in both repos.

**Census — read-only, one per target, Phil's authorization per host:**

- [ ] Bovey cloud project
- [ ] AgroLink cloud project
- [ ] `bovey-rp4-01`
- [ ] `agrolink-test-01`

**Cutover, in order, each on its own go:**

- [ ] Bovey cloud: backup → rehearse on copy → block (c) → hole-fill
      `2026.08.25.001` → `verify-flyway-target.sh` green → env var → deploy.
- [ ] `bovey-rp4-01`: deploy; expect pending 0026–0053; expect the 5-second
      self-check false negative.
- [ ] AgroLink cloud: backup → rehearse the full block (d)/(e) sequence on a
      copy → execute → `verify-flyway-target.sh` green → deploy.
- [ ] `agrolink-test-01`: deploy; expect pending {0022, 0023, 0024, 0025}.

**After:**

- [ ] Delete the old branch refs (tags retained).
- [ ] File W6: port the Bovey cloud valve surface to `main`.
- [ ] File the four edge follow-up ports (W5-F1..F4 in the inventory).
- [ ] File the `deploy.sh` self-check window issue for Pi 4 hosts — three
      occurrences on `bovey-rp4-01`, never filed.

## Open questions for Phil

1. **Bovey cloud valve surface:** port it to `main` as W6, or accept two cloud
   products? This decides whether `customer/bovey` is temporary.
2. **`feat/agrolink-branding`** is not in either repository. Was it deleted, or
   is the memory note wrong?
3. **AgroLink's orphan `zone_irrigation_calibrations` table** — leave it, or
   drop it during the cutover window?
4. **Order between the two cloud projects.** They share a host. Bovey first is
   the recommendation (simpler, one guarded `UPDATE`), which also means the
   AgroLink sequence gets rehearsed while Bovey is being observed.
5. **`docker-compose.bovey.yml`:** commit a sanitised copy to the repo, or keep
   it host-local and back it up out of band?
