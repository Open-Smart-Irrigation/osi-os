# Issue #331 snapshot producer alignment plan (R5)

**Status, 2026-10-29:** R5 rebinds the R4 packet to the current osi-os base B. Council round 2 reviewed the R4 plan-only commits `4a9f3f5742ba27c92a2587b286c2c1306f783d61` (edge, parent P) and `9bf3fc560f06964625b04367443348602b107f25` (server, parent S): Sol and Claude each voted APPROVE at 9/10; the third member's vote is missing, so no full council result is claimed. Osi-os `main` then moved from P to B, and the R4 base rule stops execution of the R4 head. R5 changes only base, fetch and custody text; every editor, test target and product byte is the R4 byte. See "R5 current-base rebind". R5 is a design artifact. It has not run any proposed editor, test, binding check or gate and grants no execution, council or merge approval. A fresh independent Sol review of the exact R5 heads comes before any execution. #331 stays open: this plan aligns the remaining edge producers and the v1 prose. It does not repair cloud rows that already hold a legacy future `archived_at`.

## Packet

This plan is committed with the files below in one plan-only commit whose parent is osi-os B. The commit adds six paths: the two files retained from Q, this R5 plan, and three unchanged R3 files (two editors and the test target). The osi-server companion is committed separately in osi-server with parent S. Neither repo's commit contains the other's files.

| Path under `docs/superpowers/plans/` | Role | SHA-256 |
| --- | --- | --- |
| `2026-10-28-issue-331-snapshot-alignment.md` | this R5 plan; its own hash is recorded in the campaign reconcile report, not here | — |
| `2026-10-28-issue-331-snapshot-plan-review-r1.md` | the R1 non-author review, byte-identical to Q (blob `e681577b76524108411756923196e413a69d7ef9`) | `5fa5f8ad2b1f26143cf1f02e3d4da43459fc2126d5ce1524e672e2667791e97b` |
| `issue-331-snapshot-edit-r2.js` | flow editor, byte-identical to Q (blob `f54035c603693149fb13f51f8c1d5bfa6bc9103c`) | `b704d793b1b22a58086eb423d5b4caa4f77a1a2897e1af96ae7803460cb6cdbc` |
| `issue-331-snapshot-test-edit-r3.js` | test-first editor: guarded copy of the target below (blob `93f2372b48429d2efcd6d4c2a0121d425311a92f`) | `ba47e880021636bbfdf74a90a815ea19cd7243d080fb772cb4edbb73f35b3fa0` |
| `issue-331-snapshot-test-target-r3.js` | complete proposed `scripts/test-valve-actuation-bootstrap.js` (blob `67d257786f884e1f9779baff12c6a5bce151e03c`) | `66bcc1cd5bc7f69260a7af6a5384f4e220a5e32a52ffcadbdb611d008011ab6d` |
| `issue-331-contract-edit-r3.js` | v1 prose editor for the two contract files (blob `3c8f404660f13d3cb8a682f6c50b41278aca28b9`) | `e5266d4876cd019d40367a83915205fd805e70e7685934f062b99bdda8520981` |

The two R3 editors and the R3 test target keep their R3 bytes; R4 and R5 change only plan text, the companion plan and the external binding.

osi-server companion, under the same directory in that repo: `2026-10-28-issue-331-contract-vendor-companion.md` (the R5 companion, SHA-256 `d78244e0334176f84e3afaef72c169ada90351e120dbf6328cc0ab2d8ac72b86`) and `issue-331-vendor-copy-r3.sh` (unchanged from R3, blob `7f7f70c4a6689e88aaa9752350e336d06ee5c8cf`, SHA-256 `b75da93754057f83e07b64341fbfecc4fe5490bc323502963c9d44cb3e81716a`).

Campaign-owned and never committed to either repo: the execution binding `reports/issue-331-execution-binding-r5.sh` under the campaign root (SHA-256 `abbfe4ae94d13cee7ed5e25c59224683ba1c2b8df79658843787596d3e5b40ca`). It holds the packet pins and receives the not-yet-existing heads as arguments; see "Script guards and execution binding". The R4 binding stays unchanged as the record of the round-2 packet.

The R1 review keeps its original bytes, including its false statement that S has no contract mirror. The correction is recorded in the round-1 response below.

## Pins

| Input | Identity |
| --- | --- |
Unless a row names a change, each value below is the same object at P and at B.

| Input | Identity |
| --- | --- |
| osi-os base B (R5) | `bd1afcd248616653e1962081c8c9e3d7b19d650f`; P `f6682ef6d0d90355bded9789fb4d423136ab02bb` is its ancestor |
| B `AGENTS.md` / playbook | `846790170e70766b5ba6527804ee56c627d1931d` (P `13829e45f5ada2c2da621802eb38219c83e5de38`; one added merge-reconciliation rule) / `8d235f5ec034a2f2e277b8abab0d46807ef4b150` |
| Both maintained `flows.json` | blob `9e981742777a6e53f13d56d86ae87c0b3e844788` each |
| `scripts/test-valve-actuation-bootstrap.js` | blob `10b8cb6bfb7dbcfa266b6a2ce58c5518d5f553b5`, SHA-256 `f4224bb6e6c3282bc5d7b26c0379971b47570a65e7901a787329799fa999deb8` |
| `docs/contracts/sync-schema/resources.schema.json` | blob `fb3825f2d5687ca53fbda6511faeb7bc9af9a142`, SHA-256 `e3f5e932c9a09a33088d83b9ef25b4a38baec420b3277c2b93d4b95af56e5128` |
| `docs/contracts/sync-schema/canonicalization.md` | blob `f66f7816aa8ebf9282767d7e7ac33ae01523a02e`, SHA-256 `9e66a6fd1abe03f05e9f6f2fae9ae1a92d2a455da4532ad9664c742dbbe63463` |
| `scripts/verify-sync-op-parity.js` | B blob `f161d5675693c819b0c1dd39238e7cf5d309197f` (P `140509b4afd6c18fe034dd1cb78c2789a9204d95`; one comment line differs) |
| `osi-valve-control/runtime.js` / `dispatch.js`, both profiles | `635c1e89854a3da8b2c856576895439ca2dff532` / `031cc753f076197536dfbdc4d363a97d1ce8c15d` |
| `database/seed-blank.sql` | `7bf7ee0b33a244109bc3d14579f3cde3c7c5f5d8` (`expected_close_at TEXT NOT NULL`, line 1715) |
| osi-server base S | `4a77834859d403e35a0717500f280a36a3976ae9`; `AGENTS.md` `9c304c5fba2254639457185bdf1123d8e7db1076` |
| S vendored `backend/src/test/resources/sync-contract/resources.schema.json` / `canonicalization.md` | `fb3825f2d5687ca53fbda6511faeb7bc9af9a142` / `f66f7816aa8ebf9282767d7e7ac33ae01523a02e`, equal to P and B |
| S `ValveActuationApplier.java` / `ValveRuntimeApplier.java` / `EdgeSyncService.java` | `0edfbbd7cc5a9a36a372eba461735798b02b45ac` / `16a0031bd762b0632802e0783a994b87d311421e` / `0308dd6b9a7d238d409123781da002f700422bfc` |
| S `backend/src/main/java/org/osi/server/sync` (the directory `verify-sync-op-parity.js` scans) | tree `3b3094c73a7410bba226f80e4a47fe71e36f85e8` |
| S `scripts/verify-edge-sync-contract-vendor.sh` | `4ede9d5289efcaa01f23e695b6cc6532b46033e0` |

## Exact scope

The later edge candidate changes:

- `sync-bootstrap-build` and `sync-force-build` in canonical bcm2712 `flows.json`, and the byte-identical bcm2709 mirror: one expression and one comment per node.
- `scripts/test-valve-actuation-bootstrap.js`: replaced by the reviewed target.
- `docs/contracts/sync-schema/resources.schema.json`: the `ValveActuation.properties.archived_at.description` string only.
- `docs/contracts/sync-schema/canonicalization.md`: the `archived_at` bullet under `## Valve actuation archive` only.

The osi-server companion changes only the two vendored copies of those contract files.

The event helper already derives `archived_at` as `observed_close_at || commanded_at` (merged #329) and is untouched. The snapshot SQL keeps its four terminal states, `historyHelper.v1ReplicationPredicate('vae')` before `ORDER BY vae.commanded_at DESC LIMIT 200`, `valveControl.projectObservationExpectation` after the row map, `deriveArchiveStatus`, EUI uppercasing, `expectation_id`, `contract_version`, zone, duration and every other payload field. No schema, migration, outbox, event identity, capability, cloud applier, Java, authentication, ownership or historical row change is in this plan. The #393 snapshot-ownership repair is separate and is not assumed here.

## Council round 1 response, 2026-10-28

Round-1 votes are campaign reports `issue-331-council-sol-r1.md` (SHA-256 `c6f8bd9d1c884c88eb000fa3e4255ced541921ae69fe76bb98c296d5c0f68775`), `issue-331-council-claude-r1.md` (`8153b1081c511818740edd5990464ab2e325201a2fbeadf344906eed23354d53`) and `issue-331-council-deepseek-r1.md` (`38a1a3b29fd5b8ac03ae7ccba033c602423f881d965a80370cbf778d91d30056`).

| Finding | Response (from R3; the Claude S4 row is amended in R4) |
| --- | --- |
| All three, should: S has byte-identical mirrors of both contract files; Q line 214 and R1 review line 25 said it had none. | Correct. Both S vendors are the P blobs, and S `verify-edge-sync-contract-vendor.sh` and `SyncContractVendorTest` compare them byte for byte. Q's statement and the R1 review's line 25 were wrong. R3 adds a paired osi-server companion: a plan-only commit on S plus one commit that copies both edited files from the committed edge candidate, verified with `EDGE_CONTRACT_ROOT=<edge candidate> sh scripts/verify-edge-sync-contract-vendor.sh` and the applicable server contract gates. No Java change. The R1 review file keeps its bytes. |
| Sol S2, should (Claude S2 rated nit): the deliberately failing `e2` archive assertion ran before the later-observation and preserved-field assertions, so on P those controls were never reached. | The archive rule now has two dedicated cases per block. The observed-close case passes under both the old and the new chain. The no-observed-close case runs every non-archive assertion first and ends with one `deepEqual` over all three `archived_at` values, so the base failure reports every value the old chain produced. The shape case no longer asserts an archive time it cannot hold on both sides. |
| Sol S3 and DeepSeek 2, should: the new prose said `ValveRuntime.as_of` requires a strictly newer value; S `ValveRuntimeApplier.java` lines 84–90 apply equal timestamps. | Both replacement passages now contrast only the producer side: the edge reads `as_of` fresh from the wall clock at each emission, so it effectively never ties. No applier claim about `as_of` remains. The archive formula, millisecond UTC form, strictly-older rejection and equal-time later-arrival rule are unchanged from Q. |
| Claude S3, nit: the `e2` fixture literal also matches `e-cancelled` at line 88. | The test is replaced by a complete target whose pre-image is bound by SHA-256, so no text anchor is applied. The only fixture changes are in the new cases. |
| Claude S4, nit: the editor pin named a campaign report path. | Every editor is invoked by its committed path under `docs/superpowers/plans/`; campaign report copies are review sources only. R3 also claimed that every editor refuses to run from elsewhere and that inputs are hash-bound at execution. That overstated the scripts' own guards; R4 corrects it under "Script guards and execution binding". |
| Claude S5, follow-up: `runtime.js` lines 283–286 still say a terminal row "never changes again". | Outside this slice; the helper is untouched. The new contract prose states that a later observed close may advance `archived_at`. A separate comment fix may follow. |
| DeepSeek version call; Sol and Claude concur. | In-place v1 correction; see the next section. |

## R3 source review response, 2026-10-28

The independent Sol source review of R3 (campaign report `issue-331-snapshot-plan-r3-sol-review.md`, SHA-256 `0b17d91f4560c1eb07c988488887d57729f4fca24da17cbeaff34e89112639eb`) voted CHANGES. It is not a council round.

| Finding | R4 response |
| --- | --- |
| S1, should: the edge recipe continued when P was merely present; the companion allowed rebasing the approved plan-only commit when a path list was unchanged, and that list omitted `ValveActuationApplier.java`, `EdgeSyncService.java`, `backend-ci.yml` and the subset self-test; materialization cited a nonexistent "step 3's path rule". | One base rule for both repos. At materialization and at the start of execution, freshly fetched `origin/main` must equal P (osi-os) or S (osi-server). Otherwise the step stops and reports the drift; no rebase, path filter or moved base is allowed. Execution runs only on the exact plan heads and trees council round 2 reviews, checked by the binding. The path-rule sentence is gone. Final diff instructions name P and S. |
| S2, should: both plans gave the coordinator PR merge authority and set a merge order. | The campaign may only prepare and open the two reviewed PRs as drafts, inside the parent coordinator's authorized scope. No campaign merge, release, deploy or live access is authorized. The landing order is labeled future maintainer guidance outside campaign authority, and keeps the explanation of the temporary vendor drift between two maintainer merges. |
| S3, nit: R3 overstated what the editors and copier enforce. | "Script guards and execution binding" lists each script's own guards and, separately, the external checks before each invocation: execution HEAD equals the recorded approved plan head, editor or copier bytes equal the packet SHA-256 and Git blob, and the copier's edge input HEAD equals the recorded green committed candidate SHA. The companion separates that green implementation input from the final paired review. No script byte changes. |
| Manifest wording: "three retained files". | The edge commit adds two files retained from Q plus four R3/R4 files: this plan, the two R3 editors and the R3 test target. |

## R5 current-base rebind, 2026-10-29

**Why R4 cannot run as written.** `git fetch --no-tags --refmap= origin main` returned B, so the R4 base rule stops at its first step. The approved R4 head A has parent P, and the R4 binding requires `HEAD^` = P and a fetched `origin/main` = P in every edge mode. The R4 fetch command also writes `refs/remotes/origin/main`, which every osi-os worktree shares; the campaign now forbids that write.

**What moved between P and B.** P is an ancestor of B: 17 commits, 74 changed paths. The full accounting is the campaign report `issue-331-current-base-reconcile-r1.md`, receipts 03 to 05. In summary:

- Every input this packet binds, and every file the target test, the three editors and the contract gates read, is the same object at P and B: both maintained flows, the test (SHA-256 `f4224bb6…`), both contract files, all seven server-gated contract inputs, `runtime.js` and `dispatch.js`, the seed, the whole `database/`, `docs/contracts/`, `lib/`, `osi-history-sync-helper/` and `node_modules/` trees, the `bcm2708` flows that `check-mqtt-topics.sh` reads, and that script's mode.
- Under `conf/`, only `osi-valve-control/api.test.js` and `store.test.js` changed, identically in both profiles. No non-test module in that directory names either file.
- Inputs of named gates that did change: `verify-sync-op-parity.js` (one comment line); `verify-doc-hygiene.js` (its scope adds one GUI test file, and it scans the changed docs, `AGENTS.md`, `CHANGELOG.md` and workflows); `verify-sync-flow.js` reads the changed `IrrigationZoneCard.tsx` and spawns `verify-scoped-access.js`, which walks the module tree that holds the two changed test files; `verify-profile-parity.js` hashes both profile trees, which stay identical. None of these gates has a recorded result at B.
- CI: `migrations.yml`, `test-inventory.yml` and `typecheck.yml` add unrelated tests. `migrations.yml` still runs the target test with `node --test` on an unchanged line.

The test, flow and contract design, every editor and target byte, the copier and the forecast are therefore unchanged. The forecast remains unrun.

**R5 changes, text and binding only:**

| Item | R4 | R5 |
| --- | --- | --- |
| osi-os base | P | B: packet parent, base rule, binding constant, the four base-ref overrides, `git diff --check`, final review diff |
| fetch and base check | `fetch origin refs/heads/main:refs/remotes/origin/main`; binding reads shared `origin/main` | `fetch --no-tags --refmap= origin main`; binding reads the checkout's own `FETCH_HEAD` |
| `SERVER_JAVA` | one file's blob | new `server-java` mode: the S tree of its whole directory, which `verify-sync-op-parity.js` scans |
| binding | `issue-331-execution-binding-r4.sh` | `issue-331-execution-binding-r5.sh` |
| companion | R4 | R5: binding reference, fetch rule, edge base B |
| execution precondition | council round 2 approval of the R4 heads | fresh independent Sol acceptance of the exact R5 heads |
| publication | branch name | explicit SHA refspec, because the local osi-os branch name points at A |

Council round 2 votes (Sol 9/10 and Claude 9/10, both APPROVE) stay recorded against the R4 heads. They are not transferred to the R5 heads by this text, and no third vote or full council result is claimed.

## Version decision

The new prose corrects v1 to the producer rule already shipped by merged #329; it is not a breaking change that needs a new contract version. Evidence:

- The wire shape is unchanged. `archived_at` keeps `allOf` `CanonicalUtcTimestamp`, the `required` list is unchanged and `contract_version` stays `const 1`. Only a `description` string and one canonicalization bullet change.
- The v1 event producer already emits `observed_close_at || commanded_at` (P `runtime.js` line 299). Since #329 the v1 text has disagreed with that producer; this plan aligns the text and the two remaining snapshot producers with it.
- The cloud reads `archived_at` only as an ordering key. `ValveActuationApplier` (line 128) and `EdgeSyncService.upsertValveActuation` (line 2043) both ignore a strictly older value and apply an equal one. Neither depends on the expected-close fallback.
- No field, canonical precision, resource identity, event accounting or receiver ordering changes.

The decision carries one obligation: the server's byte-identical vendors must change with the edge text. That is the companion, not a version bump.

## Test first, on the four actual snapshot blocks

The existing `loadBlock(profile, nodeId)` extracts each real function's SQL and row map, and the nested `PROFILES × NODE_IDS` loop runs it with `node:sqlite` against the bundled `database/farming.db`. The complete target is `issue-331-snapshot-test-target-r3.js`, and the test editor writes those bytes. The diff below is a review aid with blank context lines trimmed; it is not applied:

```diff
--- a/scripts/test-valve-actuation-bootstrap.js
+++ b/scripts/test-valve-actuation-bootstrap.js
@@ -143,7 +143,7 @@
         raw.close();
       });

-      await test(`[${profile}/${nodeId}] shape matches VALVE_ACTUATION_ARCHIVED's own payload (field-for-field), zone_id resolved to zone_uuid, archived_at fallback chain`, async () => {
+      await test(`[${profile}/${nodeId}] shape matches VALVE_ACTUATION_ARCHIVED's own payload (field-for-field), zone_id resolved to zone_uuid`, async () => {
         const raw = await tempDb();
         raw.exec("INSERT INTO irrigation_zones(name, user_id, created_at, updated_at) VALUES ('Z1',1,datetime('now'),datetime('now'))");
         const zone = raw.prepare('SELECT id, zone_uuid FROM irrigation_zones LIMIT 1').get();
@@ -152,8 +152,8 @@
           commanded_at: '2026-08-20T10:00:00.000Z', commanded_duration_seconds: 900, expected_close_at: '2026-08-20T10:15:00.000Z',
           observed_open_at: '2026-08-20T10:00:05.000Z', observed_close_at: '2026-08-20T10:15:03.000Z', volume_source: 'estimated_duration_flow_rate',
         });
-        // A terminal row that never observed a close at all -- archived_at must fall back to
-        // expected_close_at (the same COALESCE order runtime.js's buildActuationPayload uses).
+        // A terminal row that never observed a close. Its archive time is asserted in the
+        // dedicated archive-order cases below, so this case stays a shape control.
         insertExpectation(raw, {
           expectation_id: 'e2', reconciliation_state: 'STALE_NO_OBSERVATION',
           commanded_at: '2026-08-21T10:00:00.000Z', expected_close_at: '2026-08-21T10:15:00.000Z',
@@ -182,7 +182,89 @@
         });
         assert.equal(byId.e2.status, 'OPEN_TIMEOUT');
         assert.equal(byId.e2.zone_uuid, null);
-        assert.equal(byId.e2.archived_at, '2026-08-21T10:15:00.000Z', 'no observed_close_at -- falls back to expected_close_at');
+        assert.equal(byId.e2.expected_close_at, '2026-08-21T10:15:00.000Z');
+        assert.equal(byId.e2.observed_close_at, null);
+        assert.equal(byId.e2.device_eui, EUI);
+        raw.close();
+      });
+
+      // Issue #331: archived_at is the observed close when one exists, otherwise the command
+      // time -- the rule runtime.js's buildActuationPayload already uses. The planned
+      // expected_close_at stays in the payload but never orders the archive.
+
+      await test(`[${profile}/${nodeId}] an observed close orders archived_at, whether it lands after or before the planned close`, async () => {
+        const raw = await tempDb();
+        insertExpectation(raw, {
+          expectation_id: 'late-observed', reconciliation_state: 'OBSERVED_COMPLETE',
+          commanded_at: '2026-08-22T10:00:00.000Z', expected_close_at: '2026-08-22T12:00:00.000Z',
+          observed_open_at: '2026-08-22T10:00:05.000Z', observed_close_at: '2026-08-22T12:05:00.000Z',
+        });
+        insertExpectation(raw, {
+          expectation_id: 'early-observed', reconciliation_state: 'OBSERVED_COMPLETE',
+          commanded_at: '2026-08-23T10:00:00.000Z', expected_close_at: '2026-08-23T12:00:00.000Z',
+          observed_open_at: '2026-08-23T10:00:05.000Z', observed_close_at: '2026-08-23T11:00:00.000Z',
+        });
+        const rows = await runBlock(block, raw, profile);
+        const byId = Object.fromEntries(rows.map((r) => [r.expectation_id, r]));
+        assert.deepEqual(Object.keys(byId).sort(), ['early-observed', 'late-observed']);
+        assert.equal(byId['late-observed'].status, 'COMPLETED');
+        assert.equal(byId['late-observed'].commanded_at, '2026-08-22T10:00:00.000Z');
+        assert.equal(byId['late-observed'].expected_close_at, '2026-08-22T12:00:00.000Z');
+        assert.equal(byId['late-observed'].observed_close_at, '2026-08-22T12:05:00.000Z');
+        assert.equal(byId['late-observed'].device_eui, EUI);
+        assert.equal(byId['early-observed'].status, 'COMPLETED');
+        assert.equal(byId['early-observed'].commanded_at, '2026-08-23T10:00:00.000Z');
+        assert.equal(byId['early-observed'].expected_close_at, '2026-08-23T12:00:00.000Z');
+        assert.equal(byId['early-observed'].observed_close_at, '2026-08-23T11:00:00.000Z');
+        assert.equal(byId['early-observed'].device_eui, EUI);
+        assert.deepEqual(
+          { 'late-observed': byId['late-observed'].archived_at, 'early-observed': byId['early-observed'].archived_at },
+          { 'late-observed': '2026-08-22T12:05:00.000Z', 'early-observed': '2026-08-23T11:00:00.000Z' },
+          'an observed close is the archive time'
+        );
+        raw.close();
+      });
+
+      await test(`[${profile}/${nodeId}] without an observed close, archived_at is commanded_at, never the planned close`, async () => {
+        const raw = await tempDb();
+        insertExpectation(raw, {
+          expectation_id: 'stale-no-close', reconciliation_state: 'STALE_NO_OBSERVATION',
+          commanded_at: '2026-08-21T10:00:00.000Z', expected_close_at: '2026-08-21T12:00:00.000Z',
+        });
+        insertExpectation(raw, {
+          expectation_id: 'open-no-close', reconciliation_state: 'STALE_OPEN_OBSERVED',
+          commanded_at: '2026-08-24T10:00:00.000Z', expected_close_at: '2026-08-24T12:00:00.000Z',
+          observed_open_at: '2026-08-24T10:00:05.000Z',
+        });
+        insertExpectation(raw, {
+          expectation_id: 'cancelled-no-close', reconciliation_state: 'CANCELLED', cancel_reason: 'operator_cancel',
+          commanded_at: '2026-08-25T10:00:00.000Z', expected_close_at: '2026-08-25T12:00:00.000Z',
+        });
+        const rows = await runBlock(block, raw, profile);
+        const byId = Object.fromEntries(rows.map((r) => [r.expectation_id, r]));
+        const field = (name) => Object.fromEntries(Object.entries(byId).map(([id, r]) => [id, r[name]]));
+        assert.deepEqual(Object.keys(byId).sort(), ['cancelled-no-close', 'open-no-close', 'stale-no-close']);
+        assert.deepEqual(field('status'), {
+          'stale-no-close': 'OPEN_TIMEOUT', 'open-no-close': 'CLOSE_TIMEOUT', 'cancelled-no-close': 'CANCELLED',
+        });
+        assert.deepEqual(field('observed_close_at'), {
+          'stale-no-close': null, 'open-no-close': null, 'cancelled-no-close': null,
+        });
+        assert.deepEqual(field('expected_close_at'), {
+          'stale-no-close': '2026-08-21T12:00:00.000Z',
+          'open-no-close': '2026-08-24T12:00:00.000Z',
+          'cancelled-no-close': '2026-08-25T12:00:00.000Z',
+        });
+        assert.deepEqual(field('device_eui'), {
+          'stale-no-close': EUI, 'open-no-close': EUI, 'cancelled-no-close': EUI,
+        });
+        // Last on purpose: the pre-#331 chain picks the planned 12:00 close for all three
+        // rows, and this one comparison reports every archived_at it produced.
+        assert.deepEqual(field('archived_at'), {
+          'stale-no-close': '2026-08-21T10:00:00.000Z',
+          'open-no-close': '2026-08-24T10:00:00.000Z',
+          'cancelled-no-close': '2026-08-25T10:00:00.000Z',
+        }, 'a planned close must not order an archive that has no observed close');
         raw.close();
       });

@@ -230,6 +312,15 @@
       });
     }
   }
+
+  const canonicalBlock = loadBlock(PROFILES[0], NODE_IDS[0]);
+  await test('snapshot valve blocks match canonical bootstrap in both profiles', () => {
+    for (const profile of PROFILES) {
+      for (const nodeId of NODE_IDS) {
+        assert.equal(loadBlock(profile, nodeId), canonicalBlock, `${profile}/${nodeId}`);
+      }
+    }
+  });
 }

 main();
```

Per block, the target keeps the seven existing cases and adds two:

| Case | Fixtures | Old chain on P | New chain |
| --- | --- | --- | --- |
| shape (title drops `archived_at fallback chain`) | `e1` full payload deep-equal, including `archived_at` = observed close 10:15:03; `e2` status, zone, preserved `expected_close_at` 10:15, null observed close, EUI | pass | pass |
| an observed close orders `archived_at` | `late-observed` closes 12:05 after planned 12:00; `early-observed` closes 11:00 before planned 12:00 | pass: observed close is first in both chains | pass |
| without an observed close, `archived_at` is `commanded_at` | `stale-no-close` (`STALE_NO_OBSERVATION`, `OPEN_TIMEOUT`), `open-no-close` (`STALE_OPEN_OBSERVED`, `CLOSE_TIMEOUT`), `cancelled-no-close` (`CANCELLED`); each commanded 10:00, planned 12:00 | every status, observed-close, planned-close and EUI assertion passes; the final `deepEqual` fails with all three values at 12:00 | pass with all three at 10:00 |

The terminal/active filter, order and 200-row cap, full-population-before-LIMIT with the validated legacy row, command failure, missing-open status and lowercase-EUI cases are unchanged. After the loops, one source-parity case requires all four extracted blocks to equal the canonical bootstrap block.

All fixtures carry a non-null `expected_close_at`, as the shipped schema requires. None is a local-only physical-run record: each has the default 900 s duration and a null `transport_json`, so `projectObservationExpectation` keeps it, as it keeps the existing `e1`.

Forecast, not a result: with the target test on the base flows (blob `9e981742777a6e53f13d56d86ae87c0b3e844788`, the same at P and B), 37 tests run, 33 pass and 4 fail. The four failures are `[<profile>/<node>] without an observed close, archived_at is commanded_at, never the planned close` for `bcm27xx_bcm2712` and `bcm27xx_bcm2709` × `sync-bootstrap-build` and `sync-force-build`. Each fails only at the last assertion, message `a planned close must not order an archive that has no observed close`, with actual values `2026-08-21T12:00:00.000Z`, `2026-08-24T12:00:00.000Z` and `2026-08-25T12:00:00.000Z`. After the flow editor, 37 of 37 are expected to pass. The receipt records the actual counts, names, assertion output and exit codes; any other failure stops the run.

## Flow edit after the observed RED

The flow editor is Q's `issue-331-snapshot-edit-r2.js`, unchanged and still unexecuted. It parses each profile and proves `JSON.stringify(flows, null, 2) + '\n'` byte-identical before any write, requires full-profile byte parity, exactly one node per target ID and exactly one old expression and old comment in each target `func`, mutates only those two `func` strings, writes the canonical serialization to both profiles, then re-reads both and checks roundtrip, parity and the new strings once per function. Its replacements in both nodes are:

```text
old expression: archived_at: r.observed_close_at || r.expected_close_at || r.commanded_at,
new expression: archived_at: r.observed_close_at || r.commanded_at,
old comment:      // buildActuationPayload) -- same field list, same archived_at fallback chain. Keep
new comment:      // buildActuationPayload) -- same fields, observed close else command time. Keep
```

The comment sits before the extracted block, so the source-parity case compares the SQL and row map only. Inspect every catch in both changed functions and record the silent-catch ratchet; P source (byte-identical at B) shows no literal empty catch in either function, but that read is not an executed gate.

## Exact v1 prose replacements

`issue-331-contract-edit-r3.js` requires both files to have their P SHA-256 before writing; B holds the same bytes. It replaces the JSON string value of `definitions.ValveActuation.properties.archived_at.description` in `resources.schema.json` and proves the parsed document differs from P only at that path. In `canonicalization.md` it replaces the 20-line `archived_at` bullet, from `` - `archived_at` — UTC instant`` through the line before `` - `status` — the edge panel's``, and keeps every other byte. It prints both post-image SHA-256 values for the receipt.

New schema description (one JSON string):

```text
Last-write-wins snapshot field: this table has no sync_version bookkeeping column of its own (unlike ValveSettings). The current edge producer derives archived_at from observed_close_at when present, otherwise commanded_at; expected_close_at is a separate planned endpoint and does not order archive updates. archived_at is a canonical UTC ISO timestamp with millisecond precision, never wall-clock 'now'. Re-emitting an unchanged row yields the same archived_at. A later observed close may advance archived_at, while a correction to other scalar fields may retain the same archived_at. Both cloud application paths accept an equal archived_at and apply the later-arriving payload; they ignore a strictly older archived_at. ValveRuntime.as_of differs on the producer side: the edge reads it fresh from the wall clock at each emission, so it effectively never ties. See canonicalization.md.
```

New canonicalization bullet:

```md
- `archived_at` — UTC instant, canonical millisecond-precision ISO. The current
  edge producer derives it from the row's `observed_close_at` when present,
  otherwise `commanded_at`. `expected_close_at` remains the separate planned
  endpoint and does not order archive updates. The producer never uses wall-clock
  `now` for this field. Re-emitting an unchanged row gives the same `archived_at`.
  A later observed close may advance it; a correction to another scalar field
  may leave it unchanged. This table (`valve_actuation_expectations`) has no
  `sync_version`/`updated_at` bookkeeping column of its own, so both cloud
  application paths compare `archived_at` to the stored value. An incoming
  strictly older value is ignored. On an equal value, the later-arriving
  payload applies, allowing a corrected trigger or volume field to land.
  `ValveRuntime.as_of` differs on the producer side: the edge reads it fresh
  from the wall clock at each emission, so it effectively never ties.
```

These words describe the shipped event helper and the aligned snapshot producers. They do not claim that a legacy gateway emits the new rule or that a cloud row holding a legacy future archive converges. Other `as_of` passages in the contract are outside this slice.

## osi-server companion

The companion plan in osi-server owns the server side at S. It re-vendors `backend/src/test/resources/sync-contract/resources.schema.json` and `canonicalization.md` from the green committed edge candidate through its guarded copier, then runs the subset gate and its self-test, the vendor gate and its self-test, `SyncContractVendorTest` with `EDGE_CONTRACT_ROOT`, and `git diff --check`. It requires freshly fetched osi-server `main` to equal S at materialization and at execution, and stops on drift. It changes no Java, Flyway, schema, authentication or ownership code. It neither depends on nor implements #393.

## Base rule

At materialization and again at the start of execution, freshly fetched `main` must equal B in osi-os and S in osi-server. Fetch with `git fetch --no-tags --refmap= origin main`: it writes the checkout's own `FETCH_HEAD` and leaves the shared `refs/remotes/origin/main` of other worktrees untouched, and the binding reads that `FETCH_HEAD`. If it differs, the step stops and reports both SHAs; it does not rebase, filter paths or adopt a moved base. Execution runs only on the exact R5 plan-only heads and trees that the fresh Sol review accepts; the binding below checks them. A later source-changing rebase is a new plan that goes through the applicable review, never an edit to an approved head during execution.

## Script guards and execution binding

R3 said that every editor refuses to run outside its committed path and that its inputs are hash-bound at execution. The scripts' own guards are narrower:

| Script | Its own guards | What it does not check |
| --- | --- | --- |
| `issue-331-snapshot-test-edit-r3.js` | its directory resolves to `docs/superpowers/plans` under the working directory; the test pre-image has the P SHA-256 (the same at B); the target has the reviewed SHA-256; the written file equals the target | Git provenance, `HEAD`, its own bytes |
| `issue-331-snapshot-edit-r2.js` (Q bytes) | none on its own location or inputs: it uses `process.cwd()`; then pre-edit no-op roundtrip of both profiles, full-profile parity, one node per target ID, one old expression and one old comment per `func`, only those two strings change, post-write roundtrip, parity and new strings once | its path, a pre-image hash, `HEAD`, its own bytes |
| `issue-331-contract-edit-r3.js` | the same directory check as the test editor; both contract pre-images have the P SHA-256 (the same at B); the parsed schema differs only at the one description; one bullet is replaced between its two markers; written bytes equal the computed output | Git provenance, `HEAD`, its own bytes |
| osi-server `issue-331-vendor-copy-r3.sh` | see the companion: clean checkouts, pre-#331 server blobs, committed and changed edge files, copy and blob equality, exactly two modified paths | that `$0` is the committed file; which edge HEAD it is given |

A directory check is not provenance. The missing checks live in an external, campaign-owned binding, `reports/issue-331-execution-binding-r5.sh` under the campaign root (SHA-256 `abbfe4ae94d13cee7ed5e25c59224683ba1c2b8df79658843787596d3e5b40ca`). Its fixed values are packet pins: B, S, the flow blob, each editor's and the copier's SHA-256 and Git blob, and the S tree of the server sync directory. Heads, trees and the green candidate SHA are arguments taken from the parent assignment and from earlier receipts. No committed file names a future SHA, and no file hashes itself. Before exec, the binding only checks and records its inputs; its editor and copier modes then execute the authorized writers. Its modes:

| Mode | Checks, then |
| --- | --- |
| `edge-start` | clean; `HEAD`, `HEAD^` and tree equal the approved edge plan head, B and approved tree; the checkout's `FETCH_HEAD` holds one record, branch `main` at B |
| `edge-plan-root` | the same without the `FETCH_HEAD` check, for a second checkout at the plan head |
| `edge-editor test\|flow\|contract` | `HEAD`, parent B and tree as above; exactly the expected dirty paths for that step (none; the test; the test and both flows); the editor's committed blob, working bytes and SHA-256 equal the packet pins; for `flow`, both committed flow blobs are the base's. Then `cd` to the root and `exec node docs/superpowers/plans/<editor>` |
| `edge-candidate` | clean; `HEAD` is the given candidate, directly on the approved plan head, whose parent is B; the diff from the plan head is exactly the five product paths; prints the candidate tree and five blobs |
| `server-java` | the given osi-server checkout's `backend/src/main/java/org/osi/server/sync` has no modified, untracked or ignored file, its committed tree is S's `3b3094c73a7410bba226f80e4a47fe71e36f85e8`, and `EdgeSyncService.java` there hashes to `0308dd6b9a7d238d409123781da002f700422bfc`; prints the absolute `SERVER_JAVA` path |
| `server-start`, `server-copy`, `server-candidate` | see the companion |

`server-java` exists because `verify-sync-op-parity.js` reads more than its argument: `collectSyncEventApplierOps` lists every `*.java` file beside `EdgeSyncService.java` and counts the ops of each `SyncEventApplier` there. R4 pinned only the one file's blob, so a checkout with that blob and different sibling files would have given a different parity input.

Each call goes through one wrapper command that compares the binding's SHA-256 with the value above before running it. The helper is defined in the caller's shell:

```sh
BINDING="$CAMPAIGN/reports/issue-331-execution-binding-r5.sh"
BINDING_SHA256=abbfe4ae94d13cee7ed5e25c59224683ba1c2b8df79658843787596d3e5b40ca
bind() {
  python3 "$CAMPAIGN/run-heavy.py" sh -c 'test "$(sha256sum < "$0" | cut -c1-64)" = "$1" || { echo "issue-331 binding: wrong binding bytes" >&2; exit 3; }; b=$0; shift; exec sh "$b" "$@"' "$BINDING" "$BINDING_SHA256" "$@"
}
```

These are routine receipts. They add no council or user approval gate.

## Materialization of the R5 heads

Each executable command is exactly one `python3 "$CAMPAIGN/run-heavy.py" COMMAND ARGS`, serial, after a fresh admission read.

1. **Edge.** In an isolated osi-os worktree on a campaign-owned branch with no commits of its own, fetch `main` with `git fetch --no-tags --refmap= origin main` and require `FETCH_HEAD` to equal B; otherwise stop and report. Fast-forward that branch to B without resetting any other checkout or branch. Write the two files retained from Q from Q's blobs (`git show 7d2b9705e31b05a15c920c51a4c0d241ded811f2:<path>`), and the four R3/R5 files (this plan, both R3 editors and the R3 test target) from their reviewed campaign sources, each checked against the SHA-256 in the campaign reconcile report. Commit `docs: plan issue 331 snapshot producer alignment (R5)` with parent B. Require `git diff-tree -r --name-status B HEAD` to list exactly the six added paths in the packet table and no product path. Record the edge plan head and tree.
2. **Server.** Follow the companion plan's materialization: a fresh campaign-owned osi-server clone, fetched `main` equal to S or stop, parent S, exactly two added plan paths. Record the companion plan head and tree.
3. Record both plan heads, parents, trees and file hashes in the reconcile receipt. The fresh Sol review examines those two exact commits, and an acceptance names them.

The R4 heads were materialized on 2026-10-28 by the recipe in R4 and remain the record of what council round 2 voted on.

## Implementation and receipts, after the fresh Sol review accepts the R5 heads

Bind at the execution boundary and record the actual value of each: `CAMPAIGN` (campaign root holding `run-heavy.py`), `EDGE_ROOT` (the isolated implementation checkout), `EDGE_PLAN_HEAD` and `EDGE_PLAN_TREE` (the accepted R5 edge plan-only commit, from the parent assignment), `SERVER_JAVA_ROOT` (a clean osi-server checkout that passes `bind server-java`; the companion checkout at its plan head qualifies, because the plan-only commit leaves the Java tree at S), `SERVER_JAVA` (the absolute path that `bind server-java` prints), and the companion's values. Before every executable command, read fresh schema-2 `pressure.json`, `/proc/meminfo` `MemAvailable`, guard PID/PGID/SID/start tick and all four activation hashes; RAM admission needs at least 8 GiB, recovery 10 GiB, and termination is below 4 GiB; swap is telemetry. Each test, probe, checker, mutation, scratch action, fetch, checkout or commit is exactly one `python3 "$CAMPAIGN/run-heavy.py" COMMAND ARGS`, serially, with no nesting. `run-heavy.py` passes the caller's working directory and environment to the command; the caller's working directory is `EDGE_ROOT` below. Record cwd, environment and base overrides, B, plan-head and candidate SHAs, direct, controller and wrapper exits, full output and failed attempts. A missing receipt is not a pass. Respect the 2026-11-01 22:30Z new-heavy cutoff.

1. `python3 "$CAMPAIGN/run-heavy.py" git -C "$EDGE_ROOT" fetch --no-tags --refmap= origin main`, then `bind edge-start "$EDGE_ROOT" "$EDGE_PLAN_HEAD" "$EDGE_PLAN_TREE"`. A failure, including `fetched main is not bd1afcd248616653e1962081c8c9e3d7b19d650f`, stops the run; report it. Then `bind server-java "$SERVER_JAVA_ROOT"` and record the printed `SERVER_JAVA`. For every later command, export `OSI_FLOWS_SIZE_BASE_REF`, `OSI_DDL_BASE_REF`, `OSI_MIGRATIONS_BASE_REF` and `OSI_IDENTITY_BASE_REF` as `bd1afcd248616653e1962081c8c9e3d7b19d650f`.
2. `bind edge-editor test "$EDGE_ROOT" "$EDGE_PLAN_HEAD" "$EDGE_PLAN_TREE"`, then `python3 "$CAMPAIGN/run-heavy.py" node scripts/test-valve-actuation-bootstrap.js` for the RED, checked against the forecast above.
3. `bind edge-editor flow "$EDGE_ROOT" "$EDGE_PLAN_HEAD" "$EDGE_PLAN_TREE"`, then the same test for GREEN: 37 of 37.
4. `bind edge-editor contract "$EDGE_ROOT" "$EDGE_PLAN_HEAD" "$EDGE_PLAN_TREE"`; record both printed hashes.
5. Commit the candidate in `EDGE_ROOT`: `python3 "$CAMPAIGN/run-heavy.py" git -C "$EDGE_ROOT" commit -m 'fix: order valve archive snapshots by observed close or command time (#331)' -m '<implementing session attribution trailer>' -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-valve-actuation-bootstrap.js docs/contracts/sync-schema/resources.schema.json docs/contracts/sync-schema/canonicalization.md`. Record `git -C "$EDGE_ROOT" rev-parse HEAD` as `EDGE_CANDIDATE`, then `bind edge-candidate "$EDGE_ROOT" "$EDGE_PLAN_HEAD" "$EDGE_CANDIDATE"`.
6. Affected gates at that clean commit, each as one wrapper command: `node scripts/test-valve-actuation-bootstrap.js` (37 of 37), `node scripts/verify-flows-fn-parse.js`, `node scripts/test-flows-wiring.js`, `node scripts/verify-no-new-silent-catch.js`, `node scripts/verify-flows-size-ratchet.js`, `node scripts/flows-bare-require-scan.js`, `node scripts/verify-profile-parity.js`, `node scripts/verify-sync-flow.js`, `node scripts/verify-sync-contract.js`, `node scripts/test-contract-schemas.js`, `node scripts/verify-communication-contract.js`, `node scripts/verify-sync-op-parity.js "$SERVER_JAVA"`, `scripts/check-mqtt-topics.sh` (an executable bash script at P and B), `node scripts/verify-no-stray-ddl.js`, `git diff --check bd1afcd248616653e1962081c8c9e3d7b19d650f HEAD`, `node .claude/skills/anti-slop-writing/slop-check.js docs/contracts/sync-schema/canonicalization.md` and `node scripts/verify-doc-hygiene.js`. `verify-sync-op-parity.js` compares event-operation sets only; a missing or mismatched server input is an input failure, not a product RED. Label an unrelated red-on-base gate with its base evidence and stop. No gate in this list has a recorded result at B; "R5 current-base rebind" names the gates whose inputs changed between P and B.
7. `bind edge-candidate "$EDGE_ROOT" "$EDGE_PLAN_HEAD" "$EDGE_CANDIDATE"` again: the gates left the commit clean and unchanged. `EDGE_CANDIDATE` is now the green committed candidate; record it in the edge receipt. It is the companion's copy input.
8. Run the osi-server companion's execution steps against `EDGE_CANDIDATE`.
9. Final paired independent review, after both candidates exist: a fresh non-author verifier inspects `git diff bd1afcd248616653e1962081c8c9e3d7b19d650f <EDGE_CANDIDATE>` in osi-os and `git diff 4a77834859d403e35a0717500f280a36a3976ae9 <COMPANION_CANDIDATE>` in osi-server, reruns the affected gates of both plans at those exact SHAs with the four base refs set to B, and records both repos' then-current fetched `main`. Drift found then is reported, not resolved inside this plan.

Any unexpected exit stops the run with its receipt. A fix needs the applicable review; it is not an amend during execution.

## Publication authority

After the final paired review, the parent coordinator may open the two reviewed PRs as drafts and register them, within its authorized scope. Both PR bodies follow the cross-repo rule in the companion plan. Server CI pairs the two PRs by branch name, so both are published as `fix/issue-331-snapshot-archive-order`. In osi-os that local branch name already points at the superseded R4 head A and is checked out in another worktree; publication therefore pushes the exact green candidate SHA with an explicit refspec (`<EDGE_CANDIDATE>:refs/heads/fix/issue-331-snapshot-archive-order`), never the local branch, never `--tags` or `--mirror`. No campaign merge, release, deploy, live gateway access or gated cloud host access is authorized. The companion's landing order is future maintainer guidance outside campaign authority.

## Boundary that stays open

Both server application paths still ignore a strictly older incoming `archived_at`. A cloud row already holding a legacy future value can therefore defeat a corrected snapshot, and older edges in a mixed fleet can still send expected-close snapshots. A separately authorized anonymized inventory and a separately reviewed correction policy must cover `ValveActuationApplier` and `EdgeSyncService.upsertValveActuation`, keep an already stored later observed close when an incoming correction omits it, and leave two distinct non-null observed closes for evidence. The stored-row ownership gap in the server snapshot upsert belongs to #393. #393 is not merged (osi-server `main` was still S on 2026-10-29); this plan assumes no ownership fix and never touches #393 work. Any #393 landing on osi-server `main` before the companion runs moves `main` and stops the companion under the base rule.

## Source basis

R5 started as a byte copy of R4 (campaign SHA-256 `aa5a205d06a2ce0c1faf9ad9f1c0741fecf8e853361ec9bb36a2313059a0abed`) and changes only the status, packet, pins, base, binding, materialization, implementation, publication and #393 text, plus the new rebind section and this paragraph; `issue-331-snapshot-plan-r4-to-r5.diff` in the campaign reports shows every change. It was written from P, B and S Git objects read in a freshly fetched osi-os worktree and a fresh osi-server clone. No editor, test, binding, checker or product gate ran while writing it.

R4 was written from pinned Git objects and campaign reports only: P and Q in osi-os. It read no new S object; its S facts are those R3 recorded and the independent Sol R3 review rechecked. It changes R3's plan (campaign SHA-256 `b7c8083917e6161ee97ae585332c1a5ac15805b4e8b4100c7b75932cc06369c8`) in the packet text, the R1 response row on editor guards, the new R3 source review response, the companion summary, the base rule, script guards and binding, materialization, implementation and publication sections, and the #393 sentence. Test, flow and contract design and every R3 script byte are unchanged. R3 adapted Q's plan (blob `50a4a50cbffcb55e264b965646f881e98ba4a797`, SHA-256 `dfa04cd972e9e8870a830f6ffc2e0de33f244d1dcea11bd58317508b0f25d5bb`), which adapted the report-owned R2 design (SHA-256 `1a522b1044b1e13a0b09ebdfa6670892e65d8a32860d2e30e2c0033a9bf2de91`). No editor, test, binding, checker or product gate ran while writing it.
