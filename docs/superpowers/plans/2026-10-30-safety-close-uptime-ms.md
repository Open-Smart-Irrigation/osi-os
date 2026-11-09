# Safety CLOSE integer uptime repair: exact execution at W

This plan binds base W, 0eaa6d87892708c66f5a004bf121656c5a52b17e. It carries the Opus source and test design without changing either patch. Codex completed the execution recipe after independent Sol's P2 finding. All new product outcomes remain UNRUN. The third-provider vote is missing; this is interim Opus/Sol work and only a maintainer can merge this actuator risk-class change.

The source/test review is safety-close-uptime-plan-sol-review-r1.md, SHA-256 9ed44ad988f85a47476845ef5a4cb2ce9f4550d6d132ee9f3b622dca0d1659bd. Its source assessment has no blocking defect. The original author report is d0f3ceee9e2dcf384a8c48e4c2931eba17e4407022d419d91f936912a662d621. Historical R references in the design below record where it was written; execution uses W exclusively.

PR582 changes seven inputs on top of R. The eight proposed target paths remain byte-identical. Parity reads the changed mirrored zone-env payloads; command safety reads the changed farming.ts and its OPEN_FOR_DURATION literal is retained. Full hygiene may read the changed contract README. The whole-tree Git envelope is conservatively recorded in the campaign packet. No historical gate result carries forward. Every gate below runs fresh at W, and any further main drift stops execution before mutation or a commit.


The R3 packet corrected plan formatting after the admitted R2 plan stopped at its staged whitespace gate. Five blank diff-context display lines lost their single space and the final empty line was removed. The separate source/test patch files are unchanged and remain the executable inputs. Its receipt and admission directories used a new r3 generation in a fresh worktree; the stopped r2 tree and receipts remain evidence. No gate or assertion was relaxed. Every replacement packet needs its own independent external admission root.

PR583 advances T to U and changes twenty tracked paths. The eight proposed safety source/test paths and every command entry script are byte-identical. The changed zone-env helper and tests remain identical across profiles; parity reads those bytes. Command safety reads farming.ts; its OPEN_FOR_DURATION literal is retained. Full documentation hygiene reads changed contract documentation. The new workflow entry and GUI/fallback files are included in the whole-tree changed-input record. No claim that dynamic loads cannot reach a changed helper is made: all selected gate groups must run fresh at W, with unchanged failure and stop rules. The focused safety inputs and expected output bindings are unchanged. This is source reconciliation, not a passing gate result. The intermediate T packet and its earlier audits are preserved outside the final packet.

PR565 (V, 5e7b6a02dc958208334ffb727b8467fea4ce607a) and PR586 advance U to W and change eighteen tracked paths. The eight safety source/test paths, the plan path and every module that the focused suites and listed gates require by static path are byte-identical at U and W. A text scan of those files finds two changed inputs read at run time. Profile parity walks the osi-lib registry and its test, changed identically in both profiles. The scoped-access harness behind two listed scripts reads that registry; its new history-helper key names the same osi-history-helper directory as the former fallback. Full hygiene reads the changed AGENTS.md, two skills and one system-map chapter. The size-ratchet, helper-registration and live-identity verifiers changed, and none of them reads a candidate path. Three added gate groups run them at W; the ratchet gets --base-ref W, where scripts/flows-growth-exceptions.json lists no exception. The retired allowance file stays untouched, because custody refuses any changed path outside the nine. Historical PLAN_HEAD 47a8838c8bdeb1f752018b43d404112b5d25506d, TEST_HEAD 8106968f2be2ffafc667d2cf72ee695531ac4a3b and their accepted RED review bind U, not W. This plan makes new plan and test commits on W, reruns RED in both profiles and needs a new independent RED review before the product stage.

## Defect and root cause

`osi-irrigation-policy/clock.js:43` computes `Number.parseFloat(token) * 1000`. `dispatch.js:49` builds the runtime receipt only when `Number.isInteger(runtime.uptime)`. For a valid `/proc/uptime` of `2.01` the product is `2009.9999999999998`, so the receipt is dropped. An untrusted-clock permanent CLOSE without an expiry then throws `clock_untrusted` at `dispatch.js:1084`, before any reservation or transport call. Sol reproduced this at B, PR575 head and Q (`2.01` fails, `1.12`/`1.13` pass), and R carries the same bytes. Missing CI uptime data does not weaken that reproduction.

The `01-source-audit` arithmetic (current reader formula only, no product code loaded) shows how often it happens:

- **Frequency.** 150,984 of the 8,640,001 centisecond readings in the first day of uptime (1.75%) give a non-integer. The first 600 s contain 1,175, including 2.01, 2.03, 4.02, 4.03, 4.06 and 4.07.
- **Error direction.** The error runs both ways: `4.03` gives `4030.0000000000005`.

Every caller that reads uptime through `readRuntimeClock` is affected:

| Consumer | Effect of a fractional reading today |
|---|---|
| `dispatch.runtimeAttemptContext` → `executeValveAttempt` (reservation, final and claim contexts) | Receipt is null. The unbounded safe CLOSE is refused with `clock_untrusted`, or with `close_receipt_unproven` at claim. |
| `dispatch.observeClosedEvidence` and `workers.js:404` observation | Receipt is null, which gives `closed_evidence_receipt_missing` / an untrusted observation. |
| `clock.runtimeClockStatus` → `clockStatus` (also the diagnostic inside `openClockStatus`) | The NTP hook writes `uptime_ms` with awk `%.0f` (`02-awk-audit`: `2.01` → `2010`). A reading in the same centisecond gives `uptimeElapsed = -2.27e-13`, which is reported as `clock_untrusted_jump` and **persisted** as a rejection for this boot's marker until the next stratum callback. This follows from the source; nobody has observed it. |

Timed OPEN is unaffected. Since the owner decision of 2026-10-24, open paths use the marker status only as a diagnostic.

## Repair design

Change one function in both profiles: convert the decimal token to integer milliseconds at the reader boundary.

- **Supported input:** the first whitespace-separated token of the uptime file must match `^(\d+)(?:\.(\d{1,3}))?$`, meaning whole seconds plus at most three fractional digits. Linux prints two decimals. The existing tests use `55.0`, `100.000` and integer forms. The result is `int*1000 + fraction padded to 3 digits` and must satisfy `Number.isSafeInteger`. Below 2^53 every step is exact integer arithmetic, so the conversion is exact.
- **Invalid or missing input:** a missing file, an empty token, a non-numeric token, `NaN`/`Infinity`, a sign, exponent or hex notation, trailing junk, `2.`/`.5`, more than three fractional digits, or a value above `MAX_SAFE_INTEGER` ms each give `uptime: null`. Callers already treat null as untrusted: no receipt, `clock_untrusted_runtime`, and the existing refusals.
- **Deliberate tightening:** today `-2.00`, `1e3`, `+1`, `0x10` and `2.`/`.5` produce integer "uptimes", and `2.01abc` and `2.0001` produce fractions. The fixture audit found no current test or fixture that relies on any of these.
- **Monotonic order:** for accepted tokens the mapping is exactly the decimal value times 1000, so it preserves strict order. Successive kernel readings can never produce a smaller receipt.
- **Hook agreement:** awk `%.0f` of `v*1000` returns the same integer for any value with three or fewer decimals below about 2^50 ms. The rounding error stays below 0.5, as the `02-awk-audit` samples confirm. So the marker and the reader agree within a centisecond, which removes the false jump.
- **Unchanged:** `clockStatus`, the 5 s jump tolerance, boot identity, `dispatch.js` (including `Number.isInteger` at lines 49, 910 and 1212), `effects.js` receipt validation, reservation/attempt ordering, CLOSED-evidence ordering, OPEN cutoff and lower bounds, expiry, writer ownership, enqueue deduplication, the hook, flows, schema, deploy, the guard and the exports.

I rejected these alternatives:

- Relaxing `Number.isInteger`, or rounding or fabricating a receipt in the dispatcher, would weaken a safety check and leave the clock false-jump.
- Pinning only the test clock would hide the field defect.
- `Math.round(parseFloat * 1000)` would keep accepting junk tokens and still depend on reasoning about float error.
- `Math.floor` would let the reader read 1 ms behind the hook for inputs with more than three decimals.

### Proposed source bytes (`source.patch`, SHA-256 `a55399c09506d11a60eb343f37392bb07d7651782f5cad62c9b77b82e348724f`; both profiles; resulting `clock.js` SHA-256 `c927540a7ad0c540305abbf4886aa07109931edb4d984aad00a6b5e35d99eebf`)

```diff
@@ -37,10 +37,24 @@
   return { trusted: true, reason: 'trusted' };
 }

+// /proc/uptime prints seconds with two decimals. Multiplying the parsed float
+// does not give whole milliseconds (parseFloat('2.01') * 1000 is
+// 2009.9999999999998), and the dispatcher only accepts an integer receipt, so
+// the decimal digits are converted directly. Up to three fractional digits are
+// exact and keep reading order; any other token leaves uptime untrusted (null).
+const UPTIME_SECONDS = /^(\d+)(?:\.(\d{1,3}))?$/;
+
+function uptimeMilliseconds(token) {
+  const match = UPTIME_SECONDS.exec(token);
+  if (!match) return null;
+  const ms = Number(match[1]) * 1000 + Number((match[2] || '').padEnd(3, '0'));
+  return Number.isSafeInteger(ms) ? ms : null;
+}
+
 function readRuntimeClock({ fs = fsDefault, bootPath = '/proc/sys/kernel/random/boot_id', uptimePath = '/proc/uptime', markerPath = '/var/run/osi-irrigation-clock.json' } = {}) {
   let bootId = null; let uptime = null; let marker = null;
   try { bootId = fs.readFileSync(bootPath, 'utf8').trim() || null; } catch (_) { /* untrusted */ }
-  try { const value = Number.parseFloat(fs.readFileSync(uptimePath, 'utf8').trim().split(/\s+/)[0]); uptime = Number.isFinite(value) ? value * 1000 : null; } catch (_) { /* untrusted */ }
+  try { uptime = uptimeMilliseconds(fs.readFileSync(uptimePath, 'utf8').trim().split(/\s+/)[0]); } catch (_) { /* untrusted */ }
   try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch (_) { /* untrusted */ }
   return { bootId, uptime, marker };
 }
```

### Proposed test bytes (`tests.patch`, SHA-256 `a3c8953c625fe014b1795cfd82c38de88c939c71d89ee32fde8adc6ca1d5f978`; same hunks in both profiles)

Exact bytes are in `safety-close-uptime-plan-r1/tests.patch`, with the full resulting files under `proposed/b/`. Every existing test stays byte-for-byte unchanged, including the host-clock test at `live-wrapper-4c2.test.js:93`. The "expected pre-fix failure" column comes from reading the source; none of these has run.

| File | New test | Covers | Expected pre-fix failure |
|---|---|---|---|
| `clock.test.js` | real procfs-format files → exact integer ms | the real `node:fs` reader with temp files at `2.01`, `1.12`, `1.13` | `uptime` is `2009.9999999999998`, not `2010` |
| | every centisecond reading → exact, strictly increasing ms | 0.00–200.00 s; formats `55.0`, `100.000`, `0`, `7`, `0.001`, `MAX_SAFE` boundary | fails at `2.01` |
| | missing/malformed/negative/non-finite/sub-ms → null | 15 refused tokens; missing uptime file; missing boot id gives `bootId: null` | `-2.00` gives `-2000` |
| | marker written at 2.01 s stays trusted in the same centisecond | the hook/reader agreement at `runtimeClockStatus`; no rejection file written | `clock_untrusted_jump` plus a persisted rejection |
| `composition-4c2.test.js` | untrusted-clock safety CLOSE at `2.01`/`1.12`/`1.13` | direct `executeValveAttempt`: exactly one enqueue, no `expiresAt`, `UNBOUNDED_SAFE_CLOSE_V1`, integer `reservation_receipt` and `attempt_receipt` equal to the reading | `clock_untrusted` at `2.01` |
| | receipts follow rising centisecond readings across second boundaries | 8 increasing fractional-today readings; attempt receipt greater than reservation receipt; one enqueue | `clock_untrusted` |
| | backward attempt receipt refused (extends `dispatch.js:908-911`) | 8 decreasing readings: `close_receipt_unproven`, zero enqueues, integer reservation receipt, no attempt receipt or phase | wrong code (`clock_untrusted`) |
| | refusals: missing/non-numeric/NaN/Infinity/negative/sub-ms uptime, missing/empty boot id | `clock_untrusted`, zero enqueues, zero expectation rows | only `-2.00` fails today (`unbounded_safe_close_invalid`, `effects.js:184-186`) |
| | CLOSED evidence in the marker centisecond settles a 2.01 s CLOSE | `observeClosedEvidence`: one quiesced owner, `OBSERVED_CLOSED`, evidence receipt `2030` ≥ attempt `2010` | first attempt refused |
| `live-wrapper-4c2.test.js` | shipped encoder sends exactly one safety CLOSE at 2.01 s | the shipped flow encoder → `live-transport` → `executeValveAttempt` with only the uptime/boot reads injected, following the file's existing `runtimeControl` pattern; one enqueue; integer receipts `2010` | `calls.length` 0, not 1 (the CI assertion) |

These existing controls stay as they are:

- boot change / wrong-boot and stale CLOSED evidence (`scripts/test-conditional-irrigation-integration.js:673-720`)
- missing attempt receipt (`composition-4c2.test.js:165`)
- CLOSED evidence before the bounded claim (`:181`)
- exact replay (`:71`)
- the fresh-instant OPEN cutoff (`:107`) and the no-NTP OPEN (`:124`)
- the lower bounds, reboot and jump checks (`clock.test.js`, `effects-safety.test.js:74-111`)

Audit `05-syntax-check` passes `node --check` on all four proposed files, which only parses them. Audit `04-apply-check` shows both patches applying to R with `git apply --check` and leaves the tree unchanged.

## Admission and execution boundaries

Only a fresh T3-owned isolated worktree is allowed. Never run this recipe in the root checkout. Custody refuses the earlier plan, author and W-assessment trees (t3-315d4381, t3-d5d4b4ba, t3-33cd98e4). Receipts use the new w2 generation; execute-r3 receipts and its runner copy are never reused. Before the plan stage, the executor records startup readiness, fetches main into its own FETCH_HEAD with no tags and an empty refmap, proves the inherited clean HEAD is an ancestor of W, and fast-forwards only its owned branch to W. This reconciliation uses the unchanged campaign wrapper and capture with unique receipts outside the recipe root. If main is not W, stop and inventory the changed inputs before any patch or commit.

The packet directory A is /home/phil/projects/osi-release-campaign-2026-10-25/reports/safety-close-uptime-w-deps-correction-r1/packet. The eight files listed in ADMISSION.sha256 are the only executable/proposed assets. Take ACCEPTED_ADMISSION_SHA from the independent acceptance record, never from a packet assertion. Before running any packet code, invoke the trusted capture on the literal Python root/member check below, with an unused evidence label outside safety-close-uptime-execute-w2. Pass the owned worktree as --worktree and 120 as --timeout-seconds. Check the wrapper, capture and binding hashes first. Capture is e26fde69a8181e5d2e4ad0bed3f828eb3a8c89b68b6da29795c2c2654ffe8a8e; its binding is a8c7b15831740d8b950a9d85407e4dfac8e6a89c4f0c669ac3b04d1a3803fff0. The original runner is 28d93dcdbbadd76faf0389c4e85039c30dfa9523f999bfffd583a222de190220.

```bash
C=/home/phil/projects/osi-release-campaign-2026-10-25
A="$C/reports/safety-close-uptime-w-deps-correction-r1/packet"
CAP="$C/reports/capture-guard-resume-20261030-1216.py"
# STAGE is exactly plan, tests or product for this separately assigned stage.
python3 "$C/run-heavy.py" python3 "$CAP" --worktree "$PWD" --receipt-dir "$C/reports/safety-close-uptime-execute-w2-admission-$STAGE" --label "admission-$STAGE" --timeout-seconds 120 -- python3 -I -c 'import hashlib,pathlib,sys; p=pathlib.Path(sys.argv[1]); assert hashlib.sha256((p/"ADMISSION.sha256").read_bytes()).hexdigest()==sys.argv[2]; rows=(p/"ADMISSION.sha256").read_text().splitlines(); assert len(rows)==8; [(lambda f,h: (hashlib.sha256(f.read_bytes()).hexdigest()==h) or (_ for _ in ()).throw(AssertionError(str(f))))(p/n,h) for h,n in [r.split("  ",1) for r in rows]]' "$A" "$ACCEPTED_ADMISSION_SHA"
```

The executable entry point is bash "$A/recipe.sh" plan, then separately assigned tests and product stages using the same script. The working directory is the owned checkout. A plan stage requires a previously unused evidence root. PLAN_HEAD and TEST_HEAD are the exact commits recorded by custody checks and admitted for their next stage; they are not moving branch names. The product stage also requires RED_REVIEW_SHA from the coordinator's review of the actual RED receipts. These runtime values are checked inputs, not instructions to invent a SHA.

The wrapper owns serialization and child lifetime; the accepted capture applies the explicit timeout to each command and signals/collects its child group. Never impose a shell timeout that strands the capture or deletes its registration. Each launch has a fresh guard/pressure/RAM check. A wrapper refusal, timeout, signal, missing status or unexpected exit is a setup stop, never RED. The initial two wrapper calls record their own exit even on failure. Later calls use the saved runner copy; only its worktree path differs, with exact diff and both hashes retained.

The runtime prerequisite is Node with node:sqlite. After product admission and temp creation, captured step 43a installs the six lock-pinned development packages from scripts/package.json and scripts/package-lock.json into a private prefix with npm ci --ignore-scripts. Both input hashes are pinned in custody.py. A private HOME, cache and empty user/global npm configs isolate the install. The helper then copies node_modules into a newly created, inode-recorded scripts/node_modules directory; npm never writes that checkout directory. Step 43b proves Ajv and ajv-formats load at the absolute-path prerequisites used by the conditional suite. No install runs in plan or tests stages. The install may fetch public lockfile dependencies; no lifecycle scripts or inherited npm credentials are used. An unexpected ignored file at stage admission refuses the fresh tree; tracked vendored modules remain supplied by the base. Environment NODE_OPTIONS and NODE_TEST_CONTEXT are removed, GIT_NO_LAZY_FETCH is set, and TMPDIR points to the stage's new mode-0700 directory. No live service, radio, server command or actual downlink is involved.

Host-clock prerequisites are absence of /var/run/osi-irrigation-clock.json, /var/run/osi-irrigation-clock-rejection.json and /var/run/osi-irrigation-clock.json.rejected.json, including dangling links. Assert this before each host-dependent suite and after it. If any appears, stop without deleting or rewriting it. No preload is used in required tests; the host-clock case remains unchanged.

## Expected results and stop conditions

Each focused RED invocation reports 41 tests: exactly the ten new names in red-names.json fail at the design's named assertions. The existing host-clock test may add its known fractional-uptime failure; retain its diagnostic separately. Every other existing test must pass, with zero skipped, cancelled or TODO tests. A matching test name alone is insufficient: inspect each actual diagnostic and source stack against the design table. Import errors, missing modules, timeouts, unexpected exception predicates or different failing assertions stop execution.

Before the product stage, save red-review.json outside the repository with test_head and one entry each for red-bcm2712 and red-bcm2709. Each entry binds stdout_sha256, ten new_failures rows with name/source_location/actual_diagnostic/oracle_matches, unexpected_failures as an empty list, and host_test_result as pass or same-known-uptime-failure. The coordinator reviews that exact evidence record and provides its SHA; a record of unchecked assertions does not qualify. The custody helper checks its binding and structure without pretending to perform semantic review.

Each focused GREEN invocation must report 41 passes, zero failures and zero skipped/cancelled/TODO cases. Each remaining listed gate must exit zero. Hook prints OK (conditional irrigation clock hook); parity prints All parity checks passed. The canonical valve suite names 12 files, conditional suite 17, mirror suite nine; no literal glob is passed. The six script paths are fully qualified below. All proposed outputs remain forecasts until their exact command runs.

The commit chain is W, one plan-only commit, one six-test-path commit, then one two-source-path commit. Final scope is nine files: eight product/test paths plus docs/superpowers/plans/2026-10-30-safety-close-uptime-ms.md. No hooks are bypassed. Output hashes are checked before staging and after commits. Final diff checks use W explicitly. Every later gate is part of qualification even though the product commit exists before GREEN.

Each successful stage ends with receipt collection and no owned process group left running. The tests stage removes its owned private temp directory after identity checks and group collection. Product first removes only its recorded scripts/node_modules directory at step 83a, then removes the private prefix, HOME, cache and configs inside its owned temp directory at step 84. Both tracked dependency inputs must retain their pinned bytes. On any earlier stop, collect the interrupted command first, preserve all receipts, then use a new captured label to run custody.py cleanup tests for a test-stage stop. For a product-stage stop after temp creation, first run custody.py deps-cleanup with a new label and then custody.py cleanup product with another new label. If dependency installation stopped before its ownership record was written, deps-cleanup requires scripts/node_modules to be absent and leaves private-prefix removal to temp cleanup. A path with missing or mismatched ownership is retained and reported. No failed step is retried, and no product acceptance follows a dependency setup failure. Never reuse a spent label or erase a failed receipt. If a host prerequisite or live group blocks cleanup, retain the private directory and report that fact for safe collection; do not alter host state to force cleanup.

At final handoff, write the report, hash all stable recipe receipts and the report, exclude the active sealing producer, then record that producer's and final collector's actual direct/controller/wrapper exits separately. The collector cannot seal its own unfinished output. Independent exact-head verification must rerun required gates before publication. Runtime image, Node 20, native SQLite/Node-RED HTTP and hardware qualification remain outstanding.

The optional historical preload recommendation is narrowed to its supported 1.12, 1.13 and 2.01 inputs. It is not run by this recipe. Do not invoke unsupported 2.03 or 4.03 through that immutable helper; a future verifier may separately bind an owned allowlist extension.

## Exact commands and custody checks

The following shell and Python files are copied verbatim into the external packet. The plan is copied byte-for-byte into the repository before tests. The external admission root binds all executable assets and this document; it is supplied by the reviewer to avoid self-acceptance.

### recipe.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
export GIT_NO_LAZY_FETCH=1
unset NODE_OPTIONS NODE_TEST_CONTEXT
A=/home/phil/projects/osi-release-campaign-2026-10-25/reports/safety-close-uptime-w-deps-correction-r1/packet
C=/home/phil/projects/osi-release-campaign-2026-10-25
E="$C/reports/safety-close-uptime-execute-w2"
BASE=0eaa6d87892708c66f5a004bf121656c5a52b17e
PLAN=docs/superpowers/plans/2026-10-30-safety-close-uptime-ms.md
CAP="$C/reports/capture-guard-resume-20261030-1216.py"
test -n "$ACCEPTED_ADMISSION_SHA"
# Execute the trusted external admission command in plan.md before this script.
python3 -I -c 'import hashlib,pathlib,sys; p=pathlib.Path(sys.argv[1]); assert hashlib.sha256((p/"ADMISSION.sha256").read_bytes()).hexdigest()==sys.argv[2]; rows=(p/"ADMISSION.sha256").read_text().splitlines(); assert len(rows)==8; [(lambda f,h: (hashlib.sha256(f.read_bytes()).hexdigest()==h) or (_ for _ in ()).throw(AssertionError(str(f))))(p/n,h) for h,n in [r.split("  ",1) for r in rows]]' "$A" "$ACCEPTED_ADMISSION_SHA"
cap() { python3 "$E/launch.py" "$@"; }
bootcap() {
 local label="$1"; shift
 local rc=0
 python3 "$C/run-heavy.py" python3 "$CAP" --worktree "$PWD" --receipt-dir "$E/$label" --label "$label" --timeout-seconds 120 -- "$@" || rc=$?
 printf '%s\n' "$rc" > "$E/$label.wrapper-exit"
 return "$rc"
}
check() { cap "check-$1" 120 python3 -I "$A/custody.py" result "$1" "$2"; }
case "$1" in
plan)
 test ! -e "$E"
 mkdir -m 0700 "$E"
 bootcap 00-fetch git fetch --no-tags --refmap= origin main
 bootcap 01-bootstrap python3 -I "$A/custody.py" bootstrap
 cap 02-initial-fetch-collected 120 python3 -I "$A/custody.py" collect-simple 00-fetch
 cap 03-bootstrap-collected 120 python3 -I "$A/custody.py" collect-simple 01-bootstrap
 cap 04-fresh-base 120 python3 -I "$A/custody.py" fresh-base
 cap 05-copy-plan 120 python3 -I "$A/custody.py" copy-plan
 cap 06-stage-plan 120 git add -- "$PLAN"
 cap 07-plan-diff 120 git diff --cached --check
 cap 08-plan-hygiene 180 node scripts/verify-doc-hygiene.js
 cap 09-plan-prose 120 node .claude/skills/anti-slop-writing/slop-check.js "$PLAN"
 cap 10-fetch-before-plan-commit 120 git fetch --no-tags --refmap= origin main
 cap 11-plan-state 120 python3 -I "$A/custody.py" check-work plan
 cap 12-plan-commit 120 git -c user.name=Project-OSI -c user.email=philippe.hess@opensmartirrigation.org commit -m 'docs: record safety CLOSE integer uptime plan' -m 'Design and source/tests by Claude Opus 5.5; execution-recipe correction by Codex Astra.'
 cap 13-plan-custody 120 python3 -I "$A/custody.py" commit-check plan "$BASE"
 cap 14-plan-collect 120 python3 -I "$A/custody.py" collect-stage 14-plan-collect
 ;;
tests)
 test -n "$PLAN_HEAD"
 cap 20-tests-fetch 120 git fetch --no-tags --refmap= origin main
 cap 21-tests-admission 120 python3 -I "$A/custody.py" admit plan "$PLAN_HEAD"
 cap 22-temp-create 120 python3 -I "$A/custody.py" tmp-create tests
 export TMPDIR="$E/private-tmp-tests"
 cap 23-runtime 120 node -e 'require("node:sqlite"); console.log(process.version, process.execPath)'
 cap 24-patch-tests 120 git apply "$A/tests.patch"
 cap 25-tests-bytes 120 python3 -I "$A/custody.py" check-work tests
 cap 26-stage-tests 120 git add -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js
 cap 27-tests-diff 120 git diff --cached --check
 cap 28-fetch-before-tests-commit 120 git fetch --no-tags --refmap= origin main
 cap 29-tests-state 120 python3 -I "$A/custody.py" check-work tests
 cap 30-test-commit 120 git -c user.name=Project-OSI -c user.email=philippe.hess@opensmartirrigation.org commit -m 'test: pin safety CLOSE at two-decimal uptimes' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
 cap 31-tests-custody 120 python3 -I "$A/custody.py" commit-check tests "$PLAN_HEAD"
 cap red-bcm2712-host-before 120 python3 -I "$A/custody.py" host
 if cap red-bcm2712 180 node --test --test-reporter=tap conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js; then
   echo 'Expected RED exit 1, got 0' >&2; exit 1
 else
   code=$?; test "$code" -eq 1
 fi
 check red-bcm2712 red
 cap red-bcm2709-host-before 120 python3 -I "$A/custody.py" host
 if cap red-bcm2709 180 node --test --test-reporter=tap conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js; then
   echo 'Expected RED exit 1, got 0' >&2; exit 1
 else
   code=$?; test "$code" -eq 1
 fi
 check red-bcm2709 red
 cap 32-tests-collected 120 python3 -I "$A/custody.py" finish-tests
 cap 33-tests-temp-cleanup 120 python3 -I "$A/custody.py" cleanup tests
 cap 34-tests-collect 120 python3 -I "$A/custody.py" collect-stage 34-tests-collect
 # STOP. Classify every named assertion before the separately assigned product stage.
 ;;
product)
 test -n "$TEST_HEAD"
 test -n "$RED_REVIEW_SHA"
 cap 40-product-fetch 120 git fetch --no-tags --refmap= origin main
 cap 41-product-admission 120 python3 -I "$A/custody.py" admit tests "$TEST_HEAD"
 cap 42-red-review 120 python3 -I "$A/custody.py" red-review "$RED_REVIEW_SHA"
 cap 43-product-temp 120 python3 -I "$A/custody.py" tmp-create product
 export TMPDIR="$E/private-tmp-product"
 cap 43a-dependencies 600 python3 -I "$A/custody.py" deps-prepare
 cap 43b-dependency-probe 120 node -e 'const Ajv=require("./scripts/node_modules/ajv"); const formats=require("./scripts/node_modules/ajv-formats"); const a=new Ajv(); formats(a); if(!a.validate({type:"string",format:"date"},"2026-10-30")) throw new Error("Ajv prerequisite failed"); console.log("AJV_PREREQUISITES_OK");'
 cap 44-patch-product 120 git apply "$A/source.patch"
 cap 45-product-bytes 120 python3 -I "$A/custody.py" check-work product
 cap 46-stage-product 120 git add -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.js
 cap 47-product-diff 120 git diff --cached --check
 cap 48-fetch-before-product-commit 120 git fetch --no-tags --refmap= origin main
 cap 49-product-state 120 python3 -I "$A/custody.py" check-work product
 cap 50-fix-commit 120 git -c user.name=Project-OSI -c user.email=philippe.hess@opensmartirrigation.org commit -m 'fix(valves): convert procfs uptime to exact integer milliseconds' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
 cap 51-product-custody 120 python3 -I "$A/custody.py" commit-check product "$TEST_HEAD"
 cap green-bcm2712 180 node --test --test-reporter=tap conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js
 check green-bcm2712 green
 cap green-bcm2709 180 node --test --test-reporter=tap conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js
 check green-bcm2709 green
 cap canonical-valves-host-before 120 python3 -I "$A/custody.py" host
 cap canonical-valves 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/ack.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/api.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/cancel.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/cloud-commands.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/lifecycle-clear.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/plan.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/push.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/runtime.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/store.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/unclaim.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/workers.test.js
 check canonical-valves zero
 cap canonical-conditional-host-before 120 python3 -I "$A/custody.py" host
 cap canonical-conditional 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/api.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/evaluate.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/lifecycle.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/model.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/observations.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/occurrences.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/store.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/worker.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/dispatch.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/effects-safety-dispatch.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/effects-safety.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/effects.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/writer-integration.test.js
 check canonical-conditional zero
 cap mirror-host-before 120 python3 -I "$A/custody.py" host
 cap mirror 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/worker.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/dispatch.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/effects-safety-dispatch.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/effects-safety.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/effects.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/workers.test.js
 check mirror zero
 cap test-conditional-irrigation-integration-host-before 120 python3 -I "$A/custody.py" host
 cap test-conditional-irrigation-integration 300 node --test scripts/test-conditional-irrigation-integration.js
 check test-conditional-irrigation-integration zero
 cap test-conditional-irrigation-5b1-host-before 120 python3 -I "$A/custody.py" host
 cap test-conditional-irrigation-5b1 300 node --test scripts/test-conditional-irrigation-5b1.js
 check test-conditional-irrigation-5b1 zero
 cap test-valve-command-safety-path-host-before 120 python3 -I "$A/custody.py" host
 cap test-valve-command-safety-path 300 node --test scripts/test-valve-command-safety-path.js
 check test-valve-command-safety-path zero
 cap test-request-context-isolation-host-before 120 python3 -I "$A/custody.py" host
 cap test-request-context-isolation 300 node --test scripts/test-request-context-isolation.js
 check test-request-context-isolation zero
 cap test-scoped-access-writes-host-before 120 python3 -I "$A/custody.py" host
 cap test-scoped-access-writes 300 node --test scripts/test-scoped-access-writes.js
 check test-scoped-access-writes zero
 cap test-strega-reconciliation-observed-events-host-before 120 python3 -I "$A/custody.py" host
 cap test-strega-reconciliation-observed-events 300 node --test scripts/test-strega-reconciliation-observed-events.js
 check test-strega-reconciliation-observed-events zero
 cap hook-host-before 120 python3 -I "$A/custody.py" host
 cap hook 180 node scripts/test-conditional-irrigation-clock.js
 check hook zero
 cap parity-host-before 120 python3 -I "$A/custody.py" host
 cap parity 180 node scripts/verify-profile-parity.js
 check parity zero
 cap command-safety-host-before 120 python3 -I "$A/custody.py" host
 cap command-safety 180 node scripts/verify-command-safety.js
 check command-safety zero
 cap size-ratchet-host-before 120 python3 -I "$A/custody.py" host
 cap size-ratchet 180 node scripts/verify-flows-size-ratchet.js --base-ref "$BASE"
 check size-ratchet zero
 cap helper-registration-host-before 120 python3 -I "$A/custody.py" host
 cap helper-registration 180 node scripts/verify-helper-registration.js
 check helper-registration zero
 cap live-identity-host-before 120 python3 -I "$A/custody.py" host
 cap live-identity 180 node scripts/verify-live-gateway-identity.js
 check live-identity zero
 cap 80-final-diff 120 git diff --check "$BASE" HEAD
 cap 81-final-hygiene 180 node scripts/verify-doc-hygiene.js
 cap 82-final-fetch 120 git fetch --no-tags --refmap= origin main
 cap 83-final-bytes 120 python3 -I "$A/custody.py" check-work product
 cap 83a-dependency-cleanup 120 python3 -I "$A/custody.py" deps-cleanup
 cap 84-temp-cleanup 120 python3 -I "$A/custody.py" cleanup product
 cap 85-product-collect 120 python3 -I "$A/custody.py" collect-stage 85-product-collect
 ;;
*) echo 'Unknown stage' >&2; exit 2;;
esac
```

### custody.py

```python
import difflib, hashlib, json, os, pathlib, re, shutil, subprocess, sys

A = pathlib.Path(__file__).resolve().parent
C = pathlib.Path('/home/phil/projects/osi-release-campaign-2026-10-25')
E = C / 'reports/safety-close-uptime-execute-w2'
BASE = '0eaa6d87892708c66f5a004bf121656c5a52b17e'
PLAN = 'docs/superpowers/plans/2026-10-30-safety-close-uptime-ms.md'
HOST = ['/var/run/osi-irrigation-clock.json', '/var/run/osi-irrigation-clock-rejection.json', '/var/run/osi-irrigation-clock.json.rejected.json']
W = pathlib.Path.cwd().resolve()
assert str(W).startswith('/home/phil/.t3/worktrees/osi-os/') and W != pathlib.Path('/home/phil/projects/osi-os')
assert W.name not in ('t3-315d4381', 't3-d5d4b4ba', 't3-33cd98e4'), 'use a new executor worktree'
def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def git(*args): return subprocess.check_output(['git', '--no-optional-locks', *args]).decode().strip()
def write(name, data):
    p = E / name
    assert not p.exists(), str(p)
    p.write_text(json.dumps(data, indent=2) + '\n')
def host_absent():
    assert all(not os.path.lexists(p) for p in HOST), 'host clock state present; do not modify it'
def clean(): assert git('status', '--porcelain', '--untracked-files=all') == ''
def outputs(stage):
    spec = json.loads((A / 'outputs.json').read_text())
    for p, row in spec.items():
        expected = row['after'] if stage == 'product' or (stage == 'tests' and row['kind'] == 'tests') else row['before']
        assert sha(W / p) == expected, p
def paths_since(ref): return set(git('diff', '--name-only', ref, '--').splitlines())
def allowed(stage):
    s = json.loads((A / 'outputs.json').read_text())
    return {PLAN} | {p for p,v in s.items() if stage == 'product' or (stage == 'tests' and v['kind'] == 'tests')}
def receipt(label, expected):
    p = E / label
    s = json.loads((p / 'status.json').read_text())
    triple = [s['direct_returncode'], s['controller_exit'], int((E / (label + '.wrapper-exit')).read_text())]
    assert triple == [expected]*3 and not s['timed_out'], (label, triple)
    child = json.loads((p / 'child.json').read_text())
    alive = []
    for q in pathlib.Path('/proc').iterdir():
        if not q.name.isdigit(): continue
        try:
            parts = (q / 'stat').read_text().split(') ', 1)[1].split()
            if int(parts[2]) == child['pgid']: alive.append(q.name)
        except (FileNotFoundError, ProcessLookupError, PermissionError): pass
    assert not alive, (label, alive)
    return (p / 'stdout').read_text()

DEPS_PINS = {
    'package.json': '2c738eaa00ff59119540bc18da3821c049f368895164f4acc381e8325c7ec0c4',
    'package-lock.json': 'ca411de80b49710c0ef0332a990b989b54158b8a1b8d877371b84c9cb280a73d',
}
def deps_inputs():
    for name, digest in DEPS_PINS.items(): assert sha(W/'scripts'/name) == digest, name

def product_tmp():
    own=json.loads((E/'temp-owner-product.json').read_text());p=E/'private-tmp-product'
    assert own['path']==str(p) and not p.is_symlink() and (p.stat().st_dev,p.stat().st_ino)==(own['dev'],own['ino'])
    assert p.stat().st_uid == os.getuid() and p.stat().st_mode & 0o777 == 0o700
    return p

def owned_groups_absent():
    groups={json.loads(q.read_text())['pgid'] for q in E.glob('*/child.json')} - {os.getpgrp()}
    for q in pathlib.Path('/proc').iterdir():
        if not q.name.isdigit(): continue
        try: assert int((q/'stat').read_text().split(') ',1)[1].split()[2]) not in groups
        except (FileNotFoundError, ProcessLookupError, PermissionError): pass

def deps_prepare():
    host_absent();deps_inputs();p=product_tmp();nm=W/'scripts/node_modules'
    assert os.environ.get('TMPDIR')==str(p)
    assert not os.path.lexists(nm) and not os.path.lexists(E/'deps-owner.json')
    npm=shutil.which('npm');assert npm, 'npm prerequisite missing'
    prefix=p/'deps-prefix';prefix.mkdir(mode=0o700)
    home=p/'npm-home';home.mkdir(mode=0o700)
    cache=p/'npm-cache';cache.mkdir(mode=0o700)
    uc=p/'npm-userconfig';gc=p/'npm-globalconfig';uc.write_text('');gc.write_text('')
    for name in DEPS_PINS: shutil.copyfile(W/'scripts'/name,prefix/name)
    env={'PATH':os.environ['PATH'],'HOME':str(home),'TMPDIR':str(p),'LANG':'C.UTF-8',
         'NPM_CONFIG_USERCONFIG':str(uc),'NPM_CONFIG_GLOBALCONFIG':str(gc),'NPM_CONFIG_CACHE':str(cache)}
    subprocess.run([npm,'--version'],check=True,cwd=prefix,env=env)
    subprocess.run([npm,'ci','--ignore-scripts','--no-audit','--no-fund','--include=dev','--prefix',str(prefix)],check=True,cwd=prefix,env=env)
    for name,digest in DEPS_PINS.items():assert sha(prefix/name)==digest,name
    deps_inputs();assert not os.path.lexists(nm)
    # Keep a stable owned directory inode; npm only writes inside the private prefix.
    nm.mkdir(mode=0o700)
    write('deps-owner.json',{'worktree':str(W),'path':str(nm),'dev':nm.stat().st_dev,'ino':nm.stat().st_ino,'uid':nm.stat().st_uid,'prefix':str(prefix),'pins':DEPS_PINS})
    shutil.copytree(prefix/'node_modules',nm,symlinks=True,dirs_exist_ok=True)
    for name in ['ajv','ajv-formats']:assert (nm/name/'package.json').is_file(),name
    deps_inputs();host_absent()
    write('deps-installed.json',{'pins':DEPS_PINS,'packages':json.loads((prefix/'package-lock.json').read_text())['packages'],'ignored_files':git('ls-files','--others','--ignored','--exclude-standard').splitlines()})

def deps_cleanup():
    host_absent();product_tmp();owned_groups_absent();nm=W/'scripts/node_modules';owner=E/'deps-owner.json'
    if not owner.exists():
        assert not os.path.lexists(nm), 'unowned dependency path; retain and report'
        write('deps-cleanup.json',{'installed':False,'path_absent':True});return
    own=json.loads(owner.read_text())
    assert own['worktree']==str(W) and own['path']==str(nm) and own['pins']==DEPS_PINS
    assert not nm.is_symlink() and (nm.stat().st_dev,nm.stat().st_ino,nm.stat().st_uid)==(own['dev'],own['ino'],own['uid'])
    assert own['uid']==os.getuid()
    deps_inputs();shutil.rmtree(nm);assert not os.path.lexists(nm)
    write('deps-cleanup.json',{'installed':True,'owner':own,'path_absent':True})

op = sys.argv[1]
if op == 'bootstrap':
    clean(); host_absent(); assert git('rev-parse', 'HEAD') == BASE
    assert git('rev-parse', 'FETCH_HEAD') == BASE
    original = C / 'reports/safety-close-uptime-plan-r1/launch.py'
    assert sha(original) == '28d93dcdbbadd76faf0389c4e85039c30dfa9523f999bfffd583a222de190220'
    assert sha(C/'reports/capture-guard-resume-20261030-1216.py') == 'e26fde69a8181e5d2e4ad0bed3f828eb3a8c89b68b6da29795c2c2654ffe8a8e'
    assert sha(C/'reports/capture-guard-resume-20261030-1216-binding.json') == 'a8c7b15831740d8b950a9d85407e4dfac8e6a89c4f0c669ac3b04d1a3803fff0'
    text = original.read_text()
    old = "'/home/phil/.t3/worktrees/osi-os/t3-315d4381'"
    assert text.count(old) == 1
    changed = text.replace(old, repr(str(W)))
    (E / 'launch.py').write_text(changed)
    (E / 'launch-original.py').write_bytes(original.read_bytes())
    (E / 'launch.diff').write_text(''.join(difflib.unified_diff(text.splitlines(True), changed.splitlines(True), fromfile='original', tofile='owned')))
    write('bootstrap.json', {'worktree':str(W), 'branch':git('branch','--show-current'), 'base':BASE, 'runner_original_sha256':sha(original), 'runner_sha256':sha(E/'launch.py'), 'capture_sha256':sha(C/'reports/capture-guard-resume-20261030-1216.py'), 'binding_sha256':sha(C/'reports/capture-guard-resume-20261030-1216-binding.json')})
    outputs('base')
elif op == 'admit':
    stage, expected_head = sys.argv[2:4]
    clean(); host_absent(); assert git('rev-parse','FETCH_HEAD') == BASE
    assert git('rev-parse','HEAD') == expected_head
    outputs(stage)
    assert paths_since(BASE) == allowed(stage)
    assert sha(W/PLAN) == sha(A/'plan.md')
    assert git('ls-files','--others','--ignored','--exclude-standard') == '', 'unexpected ignored files in fresh execution tree'
elif op == 'fresh-base':
    clean(); host_absent()
    assert git('rev-parse','HEAD') == BASE and git('rev-parse','FETCH_HEAD') == BASE
    outputs('base')
elif op == 'collect-simple':
    receipt(sys.argv[2], 0); host_absent()
elif op == 'copy-plan':
    clean(); assert git('rev-parse','HEAD') == BASE
    p=W/PLAN; assert not p.exists(); p.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(A/'plan.md',p)
elif op == 'check-work':
    stage=sys.argv[2]; outputs(stage)
    assert git('rev-parse','FETCH_HEAD') == BASE
    assert paths_since(BASE) == allowed(stage)
    assert sha(W/PLAN) == sha(A/'plan.md')
elif op == 'commit-check':
    stage, parent = sys.argv[2:4]
    clean(); outputs(stage)
    head=git('rev-parse','HEAD'); assert git('show','-s','--format=%P',head)==parent
    assert paths_since(BASE) == allowed(stage)
    assert sha(W/PLAN) == sha(A/'plan.md')
    write(stage+'-commit.json',{'head':head,'parent':parent,'tree':git('rev-parse','HEAD^{tree}'),'paths':sorted(paths_since(BASE))})
elif op == 'tmp-create':
    stage=sys.argv[2]; assert stage in ['tests','product']
    p=E/('private-tmp-'+stage); assert not p.exists(); p.mkdir(mode=0o700)
    write('temp-owner-'+stage+'.json',{'path':str(p),'dev':p.stat().st_dev,'ino':p.stat().st_ino})
elif op == 'deps-prepare':
    deps_prepare()
elif op == 'deps-cleanup':
    deps_cleanup()
elif op == 'host':
    host_absent(); print('HOST_CLOCK_FILES_ABSENT')
elif op == 'result':
    label, kind=sys.argv[2:4]
    text=receipt(label,1 if kind=='red' else 0)
    if label == 'hook': assert 'OK (conditional irrigation clock hook)' in text
    if label == 'parity': assert 'All parity checks passed.' in text
    if kind in ['red','green']:
        counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$',text,re.M)}
        assert counts['tests']==41 and all(counts[x]==0 for x in ['cancelled','skipped','todo']),counts
        if kind=='green': assert counts['pass']==41 and counts['fail']==0,counts
        else:
            names=set(re.findall(r'^not ok \d+ - (.+)$',text,re.M))
            new=set(json.loads((A/'red-names.json').read_text()))
            host='shipped encoder uses the live composition for an untrusted-clock safety CLOSE'
            assert names==new or names==new|{host},names
            assert counts['fail']==len(names) and counts['pass']==41-len(names)
            assert 'ERR_TEST_FAILURE' not in text or 'testCodeFailure' in text
    host_absent()
    write(label+'-checked.json',{'kind':kind,'receipt_sha256':sha(E/label/'status.json'),'stdout_sha256':sha(E/label/'stdout'),'stderr_sha256':sha(E/label/'stderr')})
elif op == 'finish-tests':
    for n in ['red-bcm2712','red-bcm2709']: assert (E/(n+'-checked.json')).exists()
    clean(); outputs('tests'); host_absent()
    print('TEST_STAGE_COLLECTED; inspect every named assertion before product assignment')
elif op == 'red-review':
    assert sha(E/'red-review.json') == sys.argv[2]
    r=json.loads((E/'red-review.json').read_text())
    assert r['test_head'] == git('rev-parse','HEAD')
    names=set(json.loads((A/'red-names.json').read_text()))
    for label in ['red-bcm2712','red-bcm2709']:
        text=receipt(label,1)
        assert r[label]['stdout_sha256'] == sha(E/label/'stdout')
        rows=r[label]['new_failures']
        assert {v['name'] for v in rows} == names and len(rows)==10
        assert all(v['oracle_matches'] is True and v['source_location'] and v['actual_diagnostic'] for v in rows)
        assert r[label]['unexpected_failures'] == []
        assert r[label]['host_test_result'] in ['pass','same-known-uptime-failure']
elif op == 'cleanup':
    host_absent()
    stage=sys.argv[2]; assert stage in ['tests','product']
    if stage=='product': assert not os.path.lexists(W/'scripts/node_modules'), 'collect owned dependencies first'
    own=json.loads((E/('temp-owner-'+stage+'.json')).read_text());p=E/('private-tmp-'+stage)
    assert own['path']==str(p) and not p.is_symlink() and (p.stat().st_dev,p.stat().st_ino)==(own['dev'],own['ino'])
    # Refuse cleanup while any recorded command group still exists.
    current=os.getpgrp()
    groups={json.loads(q.read_text())['pgid'] for q in E.glob('*/child.json')} - {current}
    for q in pathlib.Path('/proc').iterdir():
        if not q.name.isdigit(): continue
        try: assert int((q/'stat').read_text().split(') ',1)[1].split()[2]) not in groups
        except (FileNotFoundError, ProcessLookupError, PermissionError): pass
    shutil.rmtree(p); assert not p.exists(); write('temp-cleanup-'+stage+'.json',own)
elif op == 'collect-stage':
    current=sys.argv[2]; rows={}
    for p in sorted(E.glob('*/status.json')):
        label=p.parent.name
        if label==current: continue
        expected=1 if label in ['red-bcm2712','red-bcm2709'] else 0
        receipt(label,expected); rows[label]=[expected]*3
    host_absent(); clean()
    write(current+'-collected.json',rows)
else: raise RuntimeError('unknown operation '+op)
print('CUSTODY_OK',op)
```

### outputs.json

```json
{
  "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.js": {
    "kind": "product",
    "before": "62288cd17a9f72d959c03acc1da55c48aa88c2b0bddd6e9221562f3ce2181f7d",
    "after": "c927540a7ad0c540305abbf4886aa07109931edb4d984aad00a6b5e35d99eebf"
  },
  "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.js": {
    "kind": "product",
    "before": "62288cd17a9f72d959c03acc1da55c48aa88c2b0bddd6e9221562f3ce2181f7d",
    "after": "c927540a7ad0c540305abbf4886aa07109931edb4d984aad00a6b5e35d99eebf"
  },
  "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.test.js": {
    "kind": "tests",
    "before": "5243725361cee45c679f0d0e819d5617b64c568e0b17558e7ef73a40c383d407",
    "after": "8ceef88116815412ebdc5e3a99ab8d2c72df4f65a0883e57d777d8d41d37a6ba"
  },
  "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.test.js": {
    "kind": "tests",
    "before": "5243725361cee45c679f0d0e819d5617b64c568e0b17558e7ef73a40c383d407",
    "after": "8ceef88116815412ebdc5e3a99ab8d2c72df4f65a0883e57d777d8d41d37a6ba"
  },
  "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js": {
    "kind": "tests",
    "before": "774a3cc982086abbfc967398faaf5dfdfa6d9f54cdebf0249b5eb0acff92abc3",
    "after": "1cf155b81713bce29218065355ac7ff0eb7676f376ccbab861aaaa0405964462"
  },
  "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js": {
    "kind": "tests",
    "before": "774a3cc982086abbfc967398faaf5dfdfa6d9f54cdebf0249b5eb0acff92abc3",
    "after": "1cf155b81713bce29218065355ac7ff0eb7676f376ccbab861aaaa0405964462"
  },
  "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js": {
    "kind": "tests",
    "before": "e7e43c072c225ea19387f1adc070714befbe85672a615d0324266822255d6a97",
    "after": "e358b82b9ef940848ecd1c973cc3a7f4e58a3d7c61fec574972aa1e117e0ade4"
  },
  "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js": {
    "kind": "tests",
    "before": "e7e43c072c225ea19387f1adc070714befbe85672a615d0324266822255d6a97",
    "after": "e358b82b9ef940848ecd1c973cc3a7f4e58a3d7c61fec574972aa1e117e0ade4"
  }
}
```

### red-names.json

```json
[
  "a stratum marker written at 2.01 s uptime stays trusted when read in the same centisecond",
  "readRuntimeClock converts real procfs-format uptime files to exact integer milliseconds",
  "readRuntimeClock leaves missing, malformed, negative, non-finite and sub-millisecond uptime untrusted",
  "readRuntimeClock maps every centisecond reading to exact, strictly increasing milliseconds",
  "CLOSED evidence read in the marker centisecond settles a 2.01 s safety CLOSE with an integer receipt",
  "safety CLOSE receipts follow rising centisecond uptimes across second boundaries",
  "safety CLOSE refuses an attempt receipt that runs backward from its reservation receipt",
  "safety CLOSE still refuses missing, malformed, non-finite or negative uptime and a missing boot id",
  "untrusted-clock safety CLOSE enqueues once with integer receipts at two-decimal uptimes",
  "shipped encoder enqueues one untrusted-clock safety CLOSE at a 2.01 s uptime"
]
```

## Exact patches

### tests.patch

SHA-256 a3c8953c625fe014b1795cfd82c38de88c939c71d89ee32fde8adc6ca1d5f978

```diff
diff --git a/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.test.js b/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.test.js
--- a/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.test.js
+++ b/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.test.js
@@ -248,3 +248,82 @@
   } };
   assert.deepEqual(readRuntimeClock({ fs, markerPath: '/missing' }), { bootId: 'boot-a', uptime: 55000, marker: null });
 });
+
+function uptimeReading(text) {
+  return readRuntimeClock({ markerPath: '/missing', fs: { readFileSync(file) {
+    if (file.endsWith('boot_id')) return 'boot-a\n';
+    if (file.endsWith('uptime')) return text;
+    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
+  } } }).uptime;
+}
+
+test('readRuntimeClock converts real procfs-format uptime files to exact integer milliseconds', () => {
+  const fs = require('node:fs');
+  const os = require('node:os');
+  const path = require('node:path');
+  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-clock-uptime-'));
+  try {
+    const bootPath = path.join(dir, 'boot_id');
+    const uptimePath = path.join(dir, 'uptime');
+    fs.writeFileSync(bootPath, 'boot-a\n');
+    assert.equal(Number.parseFloat('2.01') * 1000, 2009.9999999999998);
+    for (const [text, expected] of [['2.01 0.00\n', 2010], ['1.12 3.40\n', 1120], ['1.13 3.40\n', 1130]]) {
+      fs.writeFileSync(uptimePath, text);
+      const runtime = readRuntimeClock({ bootPath, uptimePath, markerPath: path.join(dir, 'missing-marker') });
+      assert.deepEqual(runtime, { bootId: 'boot-a', uptime: expected, marker: null }, text);
+      assert.equal(Number.isInteger(runtime.uptime), true, text);
+    }
+  } finally {
+    fs.rmSync(dir, { recursive: true, force: true });
+  }
+});
+
+test('readRuntimeClock maps every centisecond reading to exact, strictly increasing milliseconds', () => {
+  let previous = -1;
+  for (let centiseconds = 0; centiseconds <= 20000; centiseconds += 1) {
+    const text = `${Math.floor(centiseconds / 100)}.${String(centiseconds % 100).padStart(2, '0')} 0.00\n`;
+    const uptime = uptimeReading(text);
+    assert.equal(uptime, centiseconds * 10, text);
+    assert.ok(uptime > previous, text);
+    previous = uptime;
+  }
+  for (const [text, expected] of [['55.0 0.0\n', 55000], ['100.000 0.00\n', 100000], ['0 0\n', 0], ['7 0\n', 7000],
+    ['0.001 0\n', 1], ['9007199254740.991 0\n', 9007199254740991]]) {
+    assert.equal(uptimeReading(text), expected, text);
+  }
+});
+
+test('readRuntimeClock leaves missing, malformed, negative, non-finite and sub-millisecond uptime untrusted', () => {
+  for (const text of ['', '\n', 'abc 0', 'NaN 0', 'Infinity 0', '-2.00 0', '+1.00 0', '1e3 0', '0x10 0', '2.01abc 0',
+    '2. 0', '.5 0', '2.0001 0', '9007199254740.992 0', `${'9'.repeat(400)} 0`]) {
+    assert.equal(uptimeReading(text), null, JSON.stringify(text));
+  }
+  const noUptime = readRuntimeClock({ markerPath: '/missing', fs: { readFileSync(file) {
+    if (file.endsWith('boot_id')) return 'boot-a\n';
+    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
+  } } });
+  assert.deepEqual(noUptime, { bootId: 'boot-a', uptime: null, marker: null });
+  const noBoot = readRuntimeClock({ markerPath: '/missing', fs: { readFileSync(file) {
+    if (file.endsWith('uptime')) return '2.01 0.00\n';
+    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
+  } } });
+  assert.deepEqual(noBoot, { bootId: null, uptime: 2010, marker: null });
+});
+
+test('a stratum marker written at 2.01 s uptime stays trusted when read in the same centisecond', () => {
+  const files = new Map([['/clock/boot', 'boot-a\n'], ['/clock/uptime', '2.01 0.00\n'],
+    ['/clock/marker', JSON.stringify({ boot_id: 'boot-a', epoch_ms: 1800000000000, uptime_ms: 2010, stratum: 2 })]]);
+  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
+  const fs = {
+    readFileSync(file) { if (files.has(file)) return files.get(file); throw missing(); },
+    writeFileSync(file, value) { files.set(file, value); },
+    mkdirSync() {},
+    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
+    unlinkSync(file) { if (!files.delete(file)) throw missing(); },
+  };
+  const status = runtimeClockStatus({ fs, bootPath: '/clock/boot', uptimePath: '/clock/uptime', markerPath: '/clock/marker',
+    rejectionPath: '/clock/rejection', fallbackPath: '/clock/rejection-fallback', now: 1800000000000 });
+  assert.deepEqual(status, { trusted: true, reason: 'trusted' });
+  assert.equal(files.has('/clock/rejection'), false);
+  assert.equal(files.has('/clock/rejection-fallback'), false);
+});
diff --git a/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js b/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js
--- a/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js
+++ b/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js
@@ -208,3 +208,149 @@
   assert.equal(after.reconciliation_state, 'PENDING_OBSERVATION');
   fixture.cleanup();
 });
+
+// Untrusted-clock runtime whose /proc/uptime reads come from a fixed list (the
+// last entry repeats). No NTP marker, so a permanent CLOSE takes the unbounded
+// safety variant. The listed two-decimal values are those parseFloat * 1000
+// turns into fractions (2.01 -> 2009.9999999999998).
+function fixedUptimeRuntime(uptimeReads, { bootId = 'fixed-uptime-boot', at = '2026-10-18T10:00:00.000Z' } = {}) {
+  const reads = Array.isArray(uptimeReads) ? uptimeReads : [uptimeReads];
+  let read = 0;
+  const fs = {
+    readFileSync(file) {
+      if (file === '/proc/sys/kernel/random/boot_id') {
+        if (bootId == null) throw Object.assign(new Error('boot id unavailable'), { code: 'ENOENT' });
+        return `${bootId}\n`;
+      }
+      if (file === '/proc/uptime') {
+        const text = reads[Math.min(read++, reads.length - 1)];
+        if (text == null) throw Object.assign(new Error('uptime unavailable'), { code: 'ENOENT' });
+        return text;
+      }
+      throw Object.assign(new Error('fixture path unavailable'), { code: 'ENOENT' });
+    },
+  };
+  return {
+    runtimeNow: () => Date.parse(at),
+    clockOptions: { fs, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath: '/var/run/osi-irrigation-clock.json', rejectionPath: '/tmp/fixed-uptime-rejection.json', fallbackPath: '/tmp/fixed-uptime-rejection-fallback.json' },
+  };
+}
+
+function safeCloseFrame() {
+  return { fPort: 1, data: Buffer.from([0x30]).toString('base64'), confirmed: false, encrypted: false, provenance: { source: 'local_encoder' } };
+}
+
+test('untrusted-clock safety CLOSE enqueues once with integer receipts at two-decimal uptimes', async () => {
+  for (const [text, uptimeMs] of [['2.01 0.00\n', 2010], ['1.12 0.00\n', 1120], ['1.13 0.00\n', 1130]]) {
+    const fixture = await tempDb();
+    const calls = [];
+    const commandId = `safe-close-uptime-${uptimeMs}`;
+    const out = await dispatch.executeValveAttempt({
+      db: fixture.db, deviceEui: EUI, command: { device_eui: EUI, command_id: commandId, action: 'CLOSE' }, frame: safeCloseFrame(),
+      transport: { async enqueueDownlink(item) { calls.push(item); return { id: `${commandId}-q` }; } },
+      now: '2026-10-18T10:00:00.000Z', trustedContext: fixedUptimeRuntime(text),
+    });
+    assert.equal(out.phase, 'ACCEPTED', text);
+    assert.equal(calls.length, 1, text);
+    assert.equal(calls[0].expiresAt, undefined, text);
+    const row = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', [commandId]);
+    const state = JSON.parse(row.transport_json);
+    assert.equal(state.effect_snapshot.timing_contract, 'UNBOUNDED_SAFE_CLOSE_V1', text);
+    assert.deepEqual(state.effect_snapshot.reservation_receipt, { boot_id: 'fixed-uptime-boot', uptime_ms: uptimeMs }, text);
+    assert.deepEqual(state.attempt_receipt, { boot_id: 'fixed-uptime-boot', uptime_ms: uptimeMs }, text);
+    fixture.cleanup();
+  }
+});
+
+test('safety CLOSE receipts follow rising centisecond uptimes across second boundaries', async () => {
+  const fixture = await tempDb();
+  const calls = [];
+  const readings = ['2.01', '2.03', '4.02', '4.03', '4.06', '4.07', '8.03', '8.04'];
+  const out = await dispatch.executeValveAttempt({
+    db: fixture.db, deviceEui: EUI, command: { device_eui: EUI, command_id: 'safe-close-uptime-rising', action: 'CLOSE' }, frame: safeCloseFrame(),
+    transport: { async enqueueDownlink(item) { calls.push(item); return { id: 'safe-close-uptime-rising-q' }; } },
+    now: '2026-10-18T10:00:00.000Z', trustedContext: fixedUptimeRuntime(readings.map((value) => `${value} 0.00\n`)),
+  });
+  assert.equal(out.phase, 'ACCEPTED');
+  assert.equal(calls.length, 1);
+  const state = JSON.parse((await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', ['safe-close-uptime-rising'])).transport_json);
+  const allowed = [2010, 2030, 4020, 4030, 4060, 4070, 8030, 8040];
+  const reserved = state.effect_snapshot.reservation_receipt.uptime_ms;
+  const attempted = state.attempt_receipt.uptime_ms;
+  assert.ok(allowed.includes(reserved), String(reserved));
+  assert.ok(allowed.includes(attempted), String(attempted));
+  assert.ok(attempted > reserved, `${attempted} > ${reserved}`);
+  fixture.cleanup();
+});
+
+test('safety CLOSE refuses an attempt receipt that runs backward from its reservation receipt', async () => {
+  const fixture = await tempDb();
+  let calls = 0;
+  const readings = ['8.04', '8.03', '4.07', '4.06', '4.03', '4.02', '2.03', '2.01'];
+  await assert.rejects(dispatch.executeValveAttempt({
+    db: fixture.db, deviceEui: EUI, command: { device_eui: EUI, command_id: 'safe-close-uptime-backward', action: 'CLOSE' }, frame: safeCloseFrame(),
+    transport: { async enqueueDownlink() { calls += 1; return { id: 'backward-must-not-enqueue' }; } },
+    now: '2026-10-18T10:00:00.000Z', trustedContext: fixedUptimeRuntime(readings.map((value) => `${value} 0.00\n`)),
+  }), (error) => error && error.code === 'close_receipt_unproven');
+  assert.equal(calls, 0);
+  const state = JSON.parse((await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', ['safe-close-uptime-backward'])).transport_json);
+  assert.equal(Number.isInteger(state.effect_snapshot.reservation_receipt.uptime_ms), true);
+  assert.equal(state.attempt_receipt, undefined);
+  assert.equal(state.phase, undefined);
+  fixture.cleanup();
+});
+
+test('safety CLOSE still refuses missing, malformed, non-finite or negative uptime and a missing boot id', async () => {
+  const cases = [
+    ['missing uptime', fixedUptimeRuntime(null)],
+    ['non-numeric uptime', fixedUptimeRuntime('abc 0.00\n')],
+    ['NaN uptime', fixedUptimeRuntime('NaN 0.00\n')],
+    ['infinite uptime', fixedUptimeRuntime('Infinity 0.00\n')],
+    ['negative uptime', fixedUptimeRuntime('-2.00 0.00\n')],
+    ['sub-millisecond uptime', fixedUptimeRuntime('2.0001 0.00\n')],
+    ['missing boot id', fixedUptimeRuntime('2.01 0.00\n', { bootId: null })],
+    ['empty boot id', fixedUptimeRuntime('2.01 0.00\n', { bootId: '' })],
+  ];
+  for (const [label, trustedContext] of cases) {
+    const fixture = await tempDb();
+    let calls = 0;
+    await assert.rejects(dispatch.executeValveAttempt({
+      db: fixture.db, deviceEui: EUI, command: { device_eui: EUI, command_id: `safe-close-refused-${label.replace(/\W+/g, '-')}`, action: 'CLOSE' }, frame: safeCloseFrame(),
+      transport: { async enqueueDownlink() { calls += 1; return { id: 'refused-must-not-enqueue' }; } },
+      now: '2026-10-18T10:00:00.000Z', trustedContext,
+    }), (error) => error && error.code === 'clock_untrusted', label);
+    assert.equal(calls, 0, label);
+    assert.equal((await fixture.db.get('SELECT COUNT(*) AS count FROM valve_actuation_expectations')).count, 0, label);
+    fixture.cleanup();
+  }
+});
+
+test('CLOSED evidence read in the marker centisecond settles a 2.01 s safety CLOSE with an integer receipt', async () => {
+  const fixture = await tempDb();
+  await dispatch.executeValveAttempt({
+    db: fixture.db, deviceEui: EUI, command: { device_eui: EUI, command_id: 'safe-close-uptime-evidence', action: 'CLOSE' }, frame: safeCloseFrame(),
+    transport: { async enqueueDownlink() { return { id: 'safe-close-uptime-evidence-q' }; } },
+    now: '2026-10-18T10:00:00.000Z', trustedContext: fixedUptimeRuntime('2.01 0.00\n'),
+  });
+  // The stratum hook wrote uptime_ms 2030 for a 2.03 s reading (awk %.0f); the
+  // runtime reads the same centisecond, so uptime has not moved backward.
+  const epoch = Date.parse('2026-10-18T10:00:00.000Z');
+  const fs = { readFileSync(file) {
+    if (file === '/proc/sys/kernel/random/boot_id') return 'fixed-uptime-boot\n';
+    if (file === '/proc/uptime') return '2.03 0.00\n';
+    if (file === '/var/run/osi-irrigation-clock.json') return JSON.stringify({ boot_id: 'fixed-uptime-boot', epoch_ms: epoch, uptime_ms: 2030, stratum: 1 });
+    throw Object.assign(new Error('fixture path unavailable'), { code: 'ENOENT' });
+  } };
+  const settled = await dispatch.observeClosedEvidence({
+    db: fixture.db, deviceEui: EUI, observedState: 'CLOSED', observedAt: '2026-10-18T10:00:00.000Z', event_identity: { fPort: 10, fCnt: 4 },
+    runtimeContext: { runtimeNow: () => epoch, clockOptions: { fs, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath: '/var/run/osi-irrigation-clock.json', rejectionPath: '/tmp/fixed-uptime-evidence-rejection.json', fallbackPath: '/tmp/fixed-uptime-evidence-rejection-fallback.json' } },
+  });
+  assert.equal(settled.quiesced.length, 1);
+  const row = await fixture.db.get('SELECT observed_close_at, reconciliation_state, transport_json FROM valve_actuation_expectations WHERE command_id=?', ['safe-close-uptime-evidence']);
+  assert.equal(row.observed_close_at, '2026-10-18T10:00:00.000Z');
+  assert.equal(row.reconciliation_state, 'OBSERVED_CLOSED');
+  const state = JSON.parse(row.transport_json);
+  assert.deepEqual(state.attempt_receipt, { boot_id: 'fixed-uptime-boot', uptime_ms: 2010 });
+  assert.deepEqual(state.closed_observation.receipt, { boot_id: 'fixed-uptime-boot', uptime_ms: 2030 });
+  fixture.cleanup();
+});
diff --git a/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js b/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js
--- a/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js
+++ b/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js
@@ -106,6 +106,39 @@
   fixture.cleanup();
 });

+// The host-clock test above depends on the machine's actual uptime; this one
+// pins the 2.01 s reading that parseFloat * 1000 turns into 2009.9999999999998.
+function fixedUptimeControl(uptimeText) {
+  const bootId = 'live-wrapper-uptime-boot';
+  const fs = { readFileSync(file) {
+    if (file === '/proc/sys/kernel/random/boot_id') return bootId + '\n';
+    if (file === '/proc/uptime') return uptimeText;
+    throw Object.assign(new Error('missing test clock path'), { code: 'ENOENT' });
+  } };
+  return { ...control, executeValveAttempt(args) {
+    return control.executeValveAttempt({ ...args, trustedContext: { clockOptions: { fs, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath: '/var/run/osi-irrigation-clock.json', rejectionPath: '/tmp/live-wrapper-uptime-rejection.json', fallbackPath: '/tmp/live-wrapper-uptime-rejection-fallback.json' } } });
+  } };
+}
+
+test('shipped encoder enqueues one untrusted-clock safety CLOSE at a 2.01 s uptime', async () => {
+  const fixture = await tempDb();
+  const calls = [];
+  const events = [];
+  const result = await invoke(encoder, fixture.db, { async enqueueDownlink(item) { calls.push(item); return { id: 'live-safe-close-uptime' }; } }, {
+    payload: { type: 'actuator_command', device: { devEui: EUI }, data: { action: 'CLOSE', commandType: 'CLOSE' } },
+  }, events, fixedUptimeControl('2.01 0.00\n'));
+  assert.equal(result[0], null);
+  assert.equal(calls.length, 1);
+  assert.equal(calls[0].expiresAt, undefined);
+  assert.equal(result[1]._log_ctx.action, 'CLOSE');
+  const row = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations ORDER BY rowid DESC LIMIT 1');
+  const state = JSON.parse(row.transport_json);
+  assert.equal(state.effect_snapshot.timing_contract, 'UNBOUNDED_SAFE_CLOSE_V1');
+  assert.deepEqual(state.effect_snapshot.reservation_receipt, { boot_id: 'live-wrapper-uptime-boot', uptime_ms: 2010 });
+  assert.deepEqual(state.attempt_receipt, { boot_id: 'live-wrapper-uptime-boot', uptime_ms: 2010 });
+  fixture.cleanup();
+});
+
 test('shipped encoder restores an actual timed OPEN and accepted replay emits no second actuator log', async () => {
   const fixture = await tempDb();
   const calls = [];
diff --git a/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.test.js b/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.test.js
--- a/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.test.js
+++ b/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.test.js
@@ -248,3 +248,82 @@
   } };
   assert.deepEqual(readRuntimeClock({ fs, markerPath: '/missing' }), { bootId: 'boot-a', uptime: 55000, marker: null });
 });
+
+function uptimeReading(text) {
+  return readRuntimeClock({ markerPath: '/missing', fs: { readFileSync(file) {
+    if (file.endsWith('boot_id')) return 'boot-a\n';
+    if (file.endsWith('uptime')) return text;
+    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
+  } } }).uptime;
+}
+
+test('readRuntimeClock converts real procfs-format uptime files to exact integer milliseconds', () => {
+  const fs = require('node:fs');
+  const os = require('node:os');
+  const path = require('node:path');
+  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-clock-uptime-'));
+  try {
+    const bootPath = path.join(dir, 'boot_id');
+    const uptimePath = path.join(dir, 'uptime');
+    fs.writeFileSync(bootPath, 'boot-a\n');
+    assert.equal(Number.parseFloat('2.01') * 1000, 2009.9999999999998);
+    for (const [text, expected] of [['2.01 0.00\n', 2010], ['1.12 3.40\n', 1120], ['1.13 3.40\n', 1130]]) {
+      fs.writeFileSync(uptimePath, text);
+      const runtime = readRuntimeClock({ bootPath, uptimePath, markerPath: path.join(dir, 'missing-marker') });
+      assert.deepEqual(runtime, { bootId: 'boot-a', uptime: expected, marker: null }, text);
+      assert.equal(Number.isInteger(runtime.uptime), true, text);
+    }
+  } finally {
+    fs.rmSync(dir, { recursive: true, force: true });
+  }
+});
+
+test('readRuntimeClock maps every centisecond reading to exact, strictly increasing milliseconds', () => {
+  let previous = -1;
+  for (let centiseconds = 0; centiseconds <= 20000; centiseconds += 1) {
+    const text = `${Math.floor(centiseconds / 100)}.${String(centiseconds % 100).padStart(2, '0')} 0.00\n`;
+    const uptime = uptimeReading(text);
+    assert.equal(uptime, centiseconds * 10, text);
+    assert.ok(uptime > previous, text);
+    previous = uptime;
+  }
+  for (const [text, expected] of [['55.0 0.0\n', 55000], ['100.000 0.00\n', 100000], ['0 0\n', 0], ['7 0\n', 7000],
+    ['0.001 0\n', 1], ['9007199254740.991 0\n', 9007199254740991]]) {
+    assert.equal(uptimeReading(text), expected, text);
+  }
+});
+
+test('readRuntimeClock leaves missing, malformed, negative, non-finite and sub-millisecond uptime untrusted', () => {
+  for (const text of ['', '\n', 'abc 0', 'NaN 0', 'Infinity 0', '-2.00 0', '+1.00 0', '1e3 0', '0x10 0', '2.01abc 0',
+    '2. 0', '.5 0', '2.0001 0', '9007199254740.992 0', `${'9'.repeat(400)} 0`]) {
+    assert.equal(uptimeReading(text), null, JSON.stringify(text));
+  }
+  const noUptime = readRuntimeClock({ markerPath: '/missing', fs: { readFileSync(file) {
+    if (file.endsWith('boot_id')) return 'boot-a\n';
+    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
+  } } });
+  assert.deepEqual(noUptime, { bootId: 'boot-a', uptime: null, marker: null });
+  const noBoot = readRuntimeClock({ markerPath: '/missing', fs: { readFileSync(file) {
+    if (file.endsWith('uptime')) return '2.01 0.00\n';
+    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
+  } } });
+  assert.deepEqual(noBoot, { bootId: null, uptime: 2010, marker: null });
+});
+
+test('a stratum marker written at 2.01 s uptime stays trusted when read in the same centisecond', () => {
+  const files = new Map([['/clock/boot', 'boot-a\n'], ['/clock/uptime', '2.01 0.00\n'],
+    ['/clock/marker', JSON.stringify({ boot_id: 'boot-a', epoch_ms: 1800000000000, uptime_ms: 2010, stratum: 2 })]]);
+  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
+  const fs = {
+    readFileSync(file) { if (files.has(file)) return files.get(file); throw missing(); },
+    writeFileSync(file, value) { files.set(file, value); },
+    mkdirSync() {},
+    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
+    unlinkSync(file) { if (!files.delete(file)) throw missing(); },
+  };
+  const status = runtimeClockStatus({ fs, bootPath: '/clock/boot', uptimePath: '/clock/uptime', markerPath: '/clock/marker',
+    rejectionPath: '/clock/rejection', fallbackPath: '/clock/rejection-fallback', now: 1800000000000 });
+  assert.deepEqual(status, { trusted: true, reason: 'trusted' });
+  assert.equal(files.has('/clock/rejection'), false);
+  assert.equal(files.has('/clock/rejection-fallback'), false);
+});
diff --git a/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js b/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js
--- a/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js
+++ b/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/composition-4c2.test.js
@@ -208,3 +208,149 @@
   assert.equal(after.reconciliation_state, 'PENDING_OBSERVATION');
   fixture.cleanup();
 });
+
+// Untrusted-clock runtime whose /proc/uptime reads come from a fixed list (the
+// last entry repeats). No NTP marker, so a permanent CLOSE takes the unbounded
+// safety variant. The listed two-decimal values are those parseFloat * 1000
+// turns into fractions (2.01 -> 2009.9999999999998).
+function fixedUptimeRuntime(uptimeReads, { bootId = 'fixed-uptime-boot', at = '2026-10-18T10:00:00.000Z' } = {}) {
+  const reads = Array.isArray(uptimeReads) ? uptimeReads : [uptimeReads];
+  let read = 0;
+  const fs = {
+    readFileSync(file) {
+      if (file === '/proc/sys/kernel/random/boot_id') {
+        if (bootId == null) throw Object.assign(new Error('boot id unavailable'), { code: 'ENOENT' });
+        return `${bootId}\n`;
+      }
+      if (file === '/proc/uptime') {
+        const text = reads[Math.min(read++, reads.length - 1)];
+        if (text == null) throw Object.assign(new Error('uptime unavailable'), { code: 'ENOENT' });
+        return text;
+      }
+      throw Object.assign(new Error('fixture path unavailable'), { code: 'ENOENT' });
+    },
+  };
+  return {
+    runtimeNow: () => Date.parse(at),
+    clockOptions: { fs, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath: '/var/run/osi-irrigation-clock.json', rejectionPath: '/tmp/fixed-uptime-rejection.json', fallbackPath: '/tmp/fixed-uptime-rejection-fallback.json' },
+  };
+}
+
+function safeCloseFrame() {
+  return { fPort: 1, data: Buffer.from([0x30]).toString('base64'), confirmed: false, encrypted: false, provenance: { source: 'local_encoder' } };
+}
+
+test('untrusted-clock safety CLOSE enqueues once with integer receipts at two-decimal uptimes', async () => {
+  for (const [text, uptimeMs] of [['2.01 0.00\n', 2010], ['1.12 0.00\n', 1120], ['1.13 0.00\n', 1130]]) {
+    const fixture = await tempDb();
+    const calls = [];
+    const commandId = `safe-close-uptime-${uptimeMs}`;
+    const out = await dispatch.executeValveAttempt({
+      db: fixture.db, deviceEui: EUI, command: { device_eui: EUI, command_id: commandId, action: 'CLOSE' }, frame: safeCloseFrame(),
+      transport: { async enqueueDownlink(item) { calls.push(item); return { id: `${commandId}-q` }; } },
+      now: '2026-10-18T10:00:00.000Z', trustedContext: fixedUptimeRuntime(text),
+    });
+    assert.equal(out.phase, 'ACCEPTED', text);
+    assert.equal(calls.length, 1, text);
+    assert.equal(calls[0].expiresAt, undefined, text);
+    const row = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', [commandId]);
+    const state = JSON.parse(row.transport_json);
+    assert.equal(state.effect_snapshot.timing_contract, 'UNBOUNDED_SAFE_CLOSE_V1', text);
+    assert.deepEqual(state.effect_snapshot.reservation_receipt, { boot_id: 'fixed-uptime-boot', uptime_ms: uptimeMs }, text);
+    assert.deepEqual(state.attempt_receipt, { boot_id: 'fixed-uptime-boot', uptime_ms: uptimeMs }, text);
+    fixture.cleanup();
+  }
+});
+
+test('safety CLOSE receipts follow rising centisecond uptimes across second boundaries', async () => {
+  const fixture = await tempDb();
+  const calls = [];
+  const readings = ['2.01', '2.03', '4.02', '4.03', '4.06', '4.07', '8.03', '8.04'];
+  const out = await dispatch.executeValveAttempt({
+    db: fixture.db, deviceEui: EUI, command: { device_eui: EUI, command_id: 'safe-close-uptime-rising', action: 'CLOSE' }, frame: safeCloseFrame(),
+    transport: { async enqueueDownlink(item) { calls.push(item); return { id: 'safe-close-uptime-rising-q' }; } },
+    now: '2026-10-18T10:00:00.000Z', trustedContext: fixedUptimeRuntime(readings.map((value) => `${value} 0.00\n`)),
+  });
+  assert.equal(out.phase, 'ACCEPTED');
+  assert.equal(calls.length, 1);
+  const state = JSON.parse((await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', ['safe-close-uptime-rising'])).transport_json);
+  const allowed = [2010, 2030, 4020, 4030, 4060, 4070, 8030, 8040];
+  const reserved = state.effect_snapshot.reservation_receipt.uptime_ms;
+  const attempted = state.attempt_receipt.uptime_ms;
+  assert.ok(allowed.includes(reserved), String(reserved));
+  assert.ok(allowed.includes(attempted), String(attempted));
+  assert.ok(attempted > reserved, `${attempted} > ${reserved}`);
+  fixture.cleanup();
+});
+
+test('safety CLOSE refuses an attempt receipt that runs backward from its reservation receipt', async () => {
+  const fixture = await tempDb();
+  let calls = 0;
+  const readings = ['8.04', '8.03', '4.07', '4.06', '4.03', '4.02', '2.03', '2.01'];
+  await assert.rejects(dispatch.executeValveAttempt({
+    db: fixture.db, deviceEui: EUI, command: { device_eui: EUI, command_id: 'safe-close-uptime-backward', action: 'CLOSE' }, frame: safeCloseFrame(),
+    transport: { async enqueueDownlink() { calls += 1; return { id: 'backward-must-not-enqueue' }; } },
+    now: '2026-10-18T10:00:00.000Z', trustedContext: fixedUptimeRuntime(readings.map((value) => `${value} 0.00\n`)),
+  }), (error) => error && error.code === 'close_receipt_unproven');
+  assert.equal(calls, 0);
+  const state = JSON.parse((await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', ['safe-close-uptime-backward'])).transport_json);
+  assert.equal(Number.isInteger(state.effect_snapshot.reservation_receipt.uptime_ms), true);
+  assert.equal(state.attempt_receipt, undefined);
+  assert.equal(state.phase, undefined);
+  fixture.cleanup();
+});
+
+test('safety CLOSE still refuses missing, malformed, non-finite or negative uptime and a missing boot id', async () => {
+  const cases = [
+    ['missing uptime', fixedUptimeRuntime(null)],
+    ['non-numeric uptime', fixedUptimeRuntime('abc 0.00\n')],
+    ['NaN uptime', fixedUptimeRuntime('NaN 0.00\n')],
+    ['infinite uptime', fixedUptimeRuntime('Infinity 0.00\n')],
+    ['negative uptime', fixedUptimeRuntime('-2.00 0.00\n')],
+    ['sub-millisecond uptime', fixedUptimeRuntime('2.0001 0.00\n')],
+    ['missing boot id', fixedUptimeRuntime('2.01 0.00\n', { bootId: null })],
+    ['empty boot id', fixedUptimeRuntime('2.01 0.00\n', { bootId: '' })],
+  ];
+  for (const [label, trustedContext] of cases) {
+    const fixture = await tempDb();
+    let calls = 0;
+    await assert.rejects(dispatch.executeValveAttempt({
+      db: fixture.db, deviceEui: EUI, command: { device_eui: EUI, command_id: `safe-close-refused-${label.replace(/\W+/g, '-')}`, action: 'CLOSE' }, frame: safeCloseFrame(),
+      transport: { async enqueueDownlink() { calls += 1; return { id: 'refused-must-not-enqueue' }; } },
+      now: '2026-10-18T10:00:00.000Z', trustedContext,
+    }), (error) => error && error.code === 'clock_untrusted', label);
+    assert.equal(calls, 0, label);
+    assert.equal((await fixture.db.get('SELECT COUNT(*) AS count FROM valve_actuation_expectations')).count, 0, label);
+    fixture.cleanup();
+  }
+});
+
+test('CLOSED evidence read in the marker centisecond settles a 2.01 s safety CLOSE with an integer receipt', async () => {
+  const fixture = await tempDb();
+  await dispatch.executeValveAttempt({
+    db: fixture.db, deviceEui: EUI, command: { device_eui: EUI, command_id: 'safe-close-uptime-evidence', action: 'CLOSE' }, frame: safeCloseFrame(),
+    transport: { async enqueueDownlink() { return { id: 'safe-close-uptime-evidence-q' }; } },
+    now: '2026-10-18T10:00:00.000Z', trustedContext: fixedUptimeRuntime('2.01 0.00\n'),
+  });
+  // The stratum hook wrote uptime_ms 2030 for a 2.03 s reading (awk %.0f); the
+  // runtime reads the same centisecond, so uptime has not moved backward.
+  const epoch = Date.parse('2026-10-18T10:00:00.000Z');
+  const fs = { readFileSync(file) {
+    if (file === '/proc/sys/kernel/random/boot_id') return 'fixed-uptime-boot\n';
+    if (file === '/proc/uptime') return '2.03 0.00\n';
+    if (file === '/var/run/osi-irrigation-clock.json') return JSON.stringify({ boot_id: 'fixed-uptime-boot', epoch_ms: epoch, uptime_ms: 2030, stratum: 1 });
+    throw Object.assign(new Error('fixture path unavailable'), { code: 'ENOENT' });
+  } };
+  const settled = await dispatch.observeClosedEvidence({
+    db: fixture.db, deviceEui: EUI, observedState: 'CLOSED', observedAt: '2026-10-18T10:00:00.000Z', event_identity: { fPort: 10, fCnt: 4 },
+    runtimeContext: { runtimeNow: () => epoch, clockOptions: { fs, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath: '/var/run/osi-irrigation-clock.json', rejectionPath: '/tmp/fixed-uptime-evidence-rejection.json', fallbackPath: '/tmp/fixed-uptime-evidence-rejection-fallback.json' } },
+  });
+  assert.equal(settled.quiesced.length, 1);
+  const row = await fixture.db.get('SELECT observed_close_at, reconciliation_state, transport_json FROM valve_actuation_expectations WHERE command_id=?', ['safe-close-uptime-evidence']);
+  assert.equal(row.observed_close_at, '2026-10-18T10:00:00.000Z');
+  assert.equal(row.reconciliation_state, 'OBSERVED_CLOSED');
+  const state = JSON.parse(row.transport_json);
+  assert.deepEqual(state.attempt_receipt, { boot_id: 'fixed-uptime-boot', uptime_ms: 2010 });
+  assert.deepEqual(state.closed_observation.receipt, { boot_id: 'fixed-uptime-boot', uptime_ms: 2030 });
+  fixture.cleanup();
+});
diff --git a/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js b/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js
--- a/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js
+++ b/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/live-wrapper-4c2.test.js
@@ -106,6 +106,39 @@
   fixture.cleanup();
 });

+// The host-clock test above depends on the machine's actual uptime; this one
+// pins the 2.01 s reading that parseFloat * 1000 turns into 2009.9999999999998.
+function fixedUptimeControl(uptimeText) {
+  const bootId = 'live-wrapper-uptime-boot';
+  const fs = { readFileSync(file) {
+    if (file === '/proc/sys/kernel/random/boot_id') return bootId + '\n';
+    if (file === '/proc/uptime') return uptimeText;
+    throw Object.assign(new Error('missing test clock path'), { code: 'ENOENT' });
+  } };
+  return { ...control, executeValveAttempt(args) {
+    return control.executeValveAttempt({ ...args, trustedContext: { clockOptions: { fs, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath: '/var/run/osi-irrigation-clock.json', rejectionPath: '/tmp/live-wrapper-uptime-rejection.json', fallbackPath: '/tmp/live-wrapper-uptime-rejection-fallback.json' } } });
+  } };
+}
+
+test('shipped encoder enqueues one untrusted-clock safety CLOSE at a 2.01 s uptime', async () => {
+  const fixture = await tempDb();
+  const calls = [];
+  const events = [];
+  const result = await invoke(encoder, fixture.db, { async enqueueDownlink(item) { calls.push(item); return { id: 'live-safe-close-uptime' }; } }, {
+    payload: { type: 'actuator_command', device: { devEui: EUI }, data: { action: 'CLOSE', commandType: 'CLOSE' } },
+  }, events, fixedUptimeControl('2.01 0.00\n'));
+  assert.equal(result[0], null);
+  assert.equal(calls.length, 1);
+  assert.equal(calls[0].expiresAt, undefined);
+  assert.equal(result[1]._log_ctx.action, 'CLOSE');
+  const row = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations ORDER BY rowid DESC LIMIT 1');
+  const state = JSON.parse(row.transport_json);
+  assert.equal(state.effect_snapshot.timing_contract, 'UNBOUNDED_SAFE_CLOSE_V1');
+  assert.deepEqual(state.effect_snapshot.reservation_receipt, { boot_id: 'live-wrapper-uptime-boot', uptime_ms: 2010 });
+  assert.deepEqual(state.attempt_receipt, { boot_id: 'live-wrapper-uptime-boot', uptime_ms: 2010 });
+  fixture.cleanup();
+});
+
 test('shipped encoder restores an actual timed OPEN and accepted replay emits no second actuator log', async () => {
   const fixture = await tempDb();
   const calls = [];
```

### source.patch

SHA-256 a55399c09506d11a60eb343f37392bb07d7651782f5cad62c9b77b82e348724f

```diff
diff --git a/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.js b/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.js
--- a/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.js
+++ b/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/clock.js
@@ -37,10 +37,24 @@
   return { trusted: true, reason: 'trusted' };
 }

+// /proc/uptime prints seconds with two decimals. Multiplying the parsed float
+// does not give whole milliseconds (parseFloat('2.01') * 1000 is
+// 2009.9999999999998), and the dispatcher only accepts an integer receipt, so
+// the decimal digits are converted directly. Up to three fractional digits are
+// exact and keep reading order; any other token leaves uptime untrusted (null).
+const UPTIME_SECONDS = /^(\d+)(?:\.(\d{1,3}))?$/;
+
+function uptimeMilliseconds(token) {
+  const match = UPTIME_SECONDS.exec(token);
+  if (!match) return null;
+  const ms = Number(match[1]) * 1000 + Number((match[2] || '').padEnd(3, '0'));
+  return Number.isSafeInteger(ms) ? ms : null;
+}
+
 function readRuntimeClock({ fs = fsDefault, bootPath = '/proc/sys/kernel/random/boot_id', uptimePath = '/proc/uptime', markerPath = '/var/run/osi-irrigation-clock.json' } = {}) {
   let bootId = null; let uptime = null; let marker = null;
   try { bootId = fs.readFileSync(bootPath, 'utf8').trim() || null; } catch (_) { /* untrusted */ }
-  try { const value = Number.parseFloat(fs.readFileSync(uptimePath, 'utf8').trim().split(/\s+/)[0]); uptime = Number.isFinite(value) ? value * 1000 : null; } catch (_) { /* untrusted */ }
+  try { uptime = uptimeMilliseconds(fs.readFileSync(uptimePath, 'utf8').trim().split(/\s+/)[0]); } catch (_) { /* untrusted */ }
   try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch (_) { /* untrusted */ }
   return { bootId, uptime, marker };
 }
diff --git a/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.js b/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.js
--- a/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.js
+++ b/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/clock.js
@@ -37,10 +37,24 @@
   return { trusted: true, reason: 'trusted' };
 }

+// /proc/uptime prints seconds with two decimals. Multiplying the parsed float
+// does not give whole milliseconds (parseFloat('2.01') * 1000 is
+// 2009.9999999999998), and the dispatcher only accepts an integer receipt, so
+// the decimal digits are converted directly. Up to three fractional digits are
+// exact and keep reading order; any other token leaves uptime untrusted (null).
+const UPTIME_SECONDS = /^(\d+)(?:\.(\d{1,3}))?$/;
+
+function uptimeMilliseconds(token) {
+  const match = UPTIME_SECONDS.exec(token);
+  if (!match) return null;
+  const ms = Number(match[1]) * 1000 + Number((match[2] || '').padEnd(3, '0'));
+  return Number.isSafeInteger(ms) ? ms : null;
+}
+
 function readRuntimeClock({ fs = fsDefault, bootPath = '/proc/sys/kernel/random/boot_id', uptimePath = '/proc/uptime', markerPath = '/var/run/osi-irrigation-clock.json' } = {}) {
   let bootId = null; let uptime = null; let marker = null;
   try { bootId = fs.readFileSync(bootPath, 'utf8').trim() || null; } catch (_) { /* untrusted */ }
-  try { const value = Number.parseFloat(fs.readFileSync(uptimePath, 'utf8').trim().split(/\s+/)[0]); uptime = Number.isFinite(value) ? value * 1000 : null; } catch (_) { /* untrusted */ }
+  try { uptime = uptimeMilliseconds(fs.readFileSync(uptimePath, 'utf8').trim().split(/\s+/)[0]); } catch (_) { /* untrusted */ }
   try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch (_) { /* untrusted */ }
   return { bootId, uptime, marker };
 }
```
