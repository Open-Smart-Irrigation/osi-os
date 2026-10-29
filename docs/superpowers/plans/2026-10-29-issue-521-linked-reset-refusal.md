# Issue 521: refuse local password reset for linked accounts

Plan date: 2026-10-29. Risk class: auth and a non-trivial `flows.json` change, so the risk-class loop in `docs/engineering-playbook.md` §2 applies. This file and its support directory are the written plan; an independent review of the commit that adds them must accept that exact commit before Task 2 starts.

Custody reference commit M: `74ff869e335529783e9c7a39e9ae1a37a8019711`. Every trusted digest in the support files is a constant taken from Git objects at M, or is computed from M at run time; the tree rule also reads the reviewed main N named below. Main moved after M; the base this plan is committed on is recorded in `reconciliation.json` (section 6) and is the parent of the plan commit.

Inputs that changed after the earlier plan base `f6682ef6d0d90355bded9789fb4d423136ab02bb`, as read from Git objects up to `0f41ff4b4729085142f973d20996857ffca1e7a1`: ten from that base to M (`AGENTS.md`, `migrations.yml`, `typecheck.yml`, GUI `package.json`, `verify-test-inventory.json`, `verify-doc-hygiene.js`, `verify-merge-allowance-preservation.js`, the Luganda tracker, `lg/common.json`, `analysis-locales.test.ts`); after M, the Luganda tracker (an Advanced Schedule section before the irrigation-forms section), `test-inventory.yml` (the valve ACK selector test) and `migrations.yml` (the reconciler scratch tests on an existing runner line). None is a security seam. The editors change the current content in place and never restore an older copy: the tracker append keeps #563's row and the Advanced Schedule section, and the CI insertion keeps every existing step and runner entry.

The complete Git tree diff from M to that main, `0f41ff4b4729085142f973d20996857ffca1e7a1` (N), has 38 entries; the source review of this plan's packet read each one and gave it a disposition (section 6.1). The custody record binds the base by its commit and tree id and lists every tree entry that differs from M, so an input that a command collects dynamically cannot change without appearing there.

Author: Opus, under the maintainer's 2026-10-29 interim arrangement while the third council provider is unavailable. The third vote is missing; this is not a full council. Merging stays with the maintainer.

## 1. Decision and scope

The maintainer selected a bounded refusal: a local administrator's password reset for a cloud-linked account (`auth_mode='server'`) answers a stable 409 and changes nothing, instead of answering 200 while the account keeps signing in with its linked credential. A cloud account-recovery feature is a separate design and authorization.

In scope: the reset branch, list and create answers of `scoped-admin-account-router`; the Users page, its service calls and type; seven `settings.json` locales; the Luganda tracker; one CI step; the size allowance.

Out of scope: cloud recovery, session revocation and generations (#520), other account writers (`RESET_SCOPED_USER_PASSWORD`, `UPSERT_SCOPED_USER`, link, unlink, `SYNC_LINKED_AUTH`), schema, migrations, seed, bundled databases, helpers, deploy pins, cloud code. No migration number is used.

## 2. Verified problem

- `POST /api/users/:uuid/password-reset` (`admin-users-password-http`) is wired to `scoped-admin-account-router`, whose only output goes to `auth-response`. After the flag, bearer, actor and fresh-admin checks, the reset branch validates a six-character `password` or `temporary_password`, runs `UPDATE users SET password_hash=?,updated_at=?,sync_version=sync_version+1 WHERE user_uuid=?` and answers `{success:true}`. It never reads `auth_mode`.
- Login (`auth-db-query` then `auth-process-result`) treats `auth_mode='server'` rows as linked: it compares a stored `server_offline_verifier` against `installation.verifierSubject(password, version, installation_uuid, gateway)` (v2 binds the installation, v1 the gateway EUI), and falls back to `server_password_hash` when no verifier is stored or the subject cannot be derived. `password_hash` is never consulted for a linked row, so the reset cannot change a linked login.
- The seed declares `auth_mode TEXT NOT NULL DEFAULT 'local'` with no CHECK, so other values can exist.
- The GUI offers "Reset password" on every row; `UsersPage.run()` swallows a failed POST, after which `submitReset` clears the form.
- `osi-db-helper`: `run()` and transaction `run()` resolve `undefined`; `transaction()` runs `BEGIN IMMEDIATE` on the shared queued connection, commits after the executor and, on any error, attempts `ROLLBACK` and attaches a failure to the original error as `rollbackError`. Facade `close()` only schedules a successful callback.
- `auth-tab` has a catch-all node wired to a 500 answer, so a `node.error(..., msg)` sends a second HTTP answer. The new code logs with `node.warn` only.

## 3. Contract

Evaluation order for `POST /api/users/:uuid/password-reset`:

| Condition | Answer | State |
|---|---|---|
| `OSI_SCOPED_ACCESS` is not `1` | 404 `{message:"Not found"}` (unchanged) | none |
| Missing or invalid bearer, actor row missing | 401 (unchanged messages) | none; same body for every target |
| Actor disabled or not admin | 403 `{message:"Forbidden"}` (unchanged) | none; same body for every target |
| `password` and `temporary_password` shorter than six characters | 400 `{message:"Password must be at least 6 characters"}` (unchanged) | none; before any target read |
| Preflight: target missing | 404 `{message:"User not found"}` | none; no bcrypt |
| Preflight: `auth_mode='server'` | 409 `{code:"linked_account_password_reset_unsupported", message:"This account uses linked sign-in. Its password cannot be reset on this gateway. Ask the linked-identity administrator for the approved recovery process."}` | none; no bcrypt |
| Preflight: any value other than `local` or `server` | 500 `{message:"The account sign-in type is not recognized. The password was not changed."}` | none; no bcrypt |
| Preflight `local` | bcrypt cost 10, outside the write lock | none yet |
| Transaction: actor id and token username no longer give the preflight actor UUID | 401 | rolled back (reads only) |
| Transaction: actor disabled or demoted | 403 | rolled back (reads only) |
| Transaction: 401 or 403 and the ROLLBACK reports failure (applied or refused) | 500 reset failure body below; private warning names the refusal and the rollback failure | uncertain; read back, never inferred |
| Transaction: target missing, `server` or unknown | 404, 409 or 500 as above | commit of reads only |
| `UPDATE ... WHERE user_uuid=? AND auth_mode='local'`, then `SELECT changes() AS n`, `n === 1` | 200 `{success:true}` after COMMIT returns | hash, `updated_at`, `sync_version+1` |
| `n === 0` and a transaction-local reread finds the target missing or `server` | 404 or 409 | commit of reads only |
| `n === 0` still local, or any other `n` (2, -1, `'1'`, 1.5, `null`, no row), or a read error | 500 `{message:"The password reset could not be completed. Reload the user list before trying again."}` | thrown, rolled back |
| BEGIN, bcrypt, UPDATE or COMMIT fault | the same 500 | rolled back where the facade reports it; otherwise uncertain |

A 200 means COMMIT returned. There is no automatic retry. When COMMIT or ROLLBACK reports failure, the 500 does not claim the row is unchanged. The linked code appears only on this 409. The reset branch's own answers (the linked 409, the unknown-type 500 and the reset-failure 500) carry no SQL text and no stored credential, and 401 and 403 keep their fixed messages. This plan does not change the router's other answers: an unchanged create-user constraint 409, for example a duplicate username, still carries the SQLite message and no `code`, as it does on the base; the control test checks only that it has no `code`.

`GET /api/users` adds `CASE auth_mode WHEN 'local' THEN 'local' WHEN 'server' THEN 'server' ELSE 'unknown' END AS auth_mode` and selects no hash, verifier, token, URL or binding field. `POST /api/users` answers `auth_mode:'local'`.

GUI: the service maps only HTTP 409 with the exact code to `LinkedPasswordResetError`; every other failure, including a 401 the session interceptor already handled, passes through unchanged. The page offers a reset only for `local` rows, labels `server` rows "Linked sign-in" with guidance and `unknown` rows "Sign-in type unavailable", keeps the selected account and both password fields after any failed POST, and says the reset "may already have been applied" when only the reload fails. An older gateway without `auth_mode` shows no reset button. An older GUI against this API still shows the form for a linked row; the server refuses with the 409 and that page shows the message and closes its form (truthful, without the new form retention).

## 4. Design notes

1. The target preflight is one queued facade read, `SELECT auth_mode FROM users WHERE user_uuid=? LIMIT 1`, after the existing actor checks and password validation. It grants no write. A `readSnapshot` would add a second handle and a close-failure state with no consistency gain.
2. Inside the transaction the actor is re-read by id and token username and must give the preflight UUID (else 401); then `scope.assertFreshRole(tx, actor.user_uuid, 'admin', {scopedMode:true})`. The helper reads only through the handle it is given, so `tx` keeps the read on the transaction connection. `assertFreshRole(db, ...)` or `db.get` here would wait behind the open transaction on the same queue; mutant M5 shows that deadlock.
3. The conditional UPDATE binds `auth_mode='local'`. `tx.run` resolves `undefined`, so `SELECT changes() AS n` follows immediately on the same connection and only the number `1` passes.
4. The reset branch has its own catch. It rethrows 401 and 403 to the router catch only when no `rollbackError` is attached. A failed ROLLBACK, whether it was applied and then reported failure or refused before applying, leaves the transaction state unknown, so it outranks an authorization refusal: the answer is the safe 500 and the private warning keeps both messages. Every other reset fault answers the safe 500, so the router catch can neither echo an error message nor turn a constraint-shaped message into a generic 409.
5. An unknown sign-in type is refused with a 500. Login would accept such a row as local; this plan does not reset an account whose mode it cannot vouch for.
6. The two existing harness facades (`scripts/lib/scoped-access-harness.js` and `scripts/lib/scope-guard-probe.js`) implement `transaction` with a transaction scope that supports `get`, so W8 in `scripts/test-scoped-access-writes.js` and `scripts/verify-scoped-access.js` stay live controls. The verifier's all-allowed run stubs both helper decisions; the real security decision is the helper's fresh role check.

## 5. Files and hunks

| File | Change |
|---|---|
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` and the bcm2709 mirror | `scoped-admin-account-router` `func` only: list SQL, create answer, reset branch. Base body 10508 chars, SHA-256 `9ef24ba1a3b2e44e7658735deded78ee457f5962c52462fd6f826ec951d34e6f`; candidate 14087 chars, SHA-256 `538bde95bd36d564b41662217fd6091eb5c86aa8ffef61a494245749b9b7fb1f`. No other node, key, wire or `libs` entry changes |
| `scripts/verify-flows-size-ratchet-allowances.json` | new `node_allowances["scoped-admin-account-router"] = {delta: 3579, reason}`; total unchanged when it still covers the head (section 11) |
| `scripts/verify-live-gateway-identity.js` | only if section 11's raise branch applies: the total pin and its two labels move to the measured value |
| `web/react-gui/src/types/farming.ts` | `AdminAuthMode` and `AdminUser.auth_mode` |
| `web/react-gui/src/services/api.ts` | users block: normalization, list and create mapping, `LINKED_PASSWORD_RESET_UNSUPPORTED`, `LinkedPasswordResetError`, `isLinkedPasswordResetError`, `normaliseAdminAuthMode`, typed `resetPassword`; one import line. Interceptors untouched |
| `web/react-gui/src/pages/admin/UsersPage.tsx` | replaced by the reviewed candidate |
| `web/react-gui/public/locales/{en,de-CH,es,fr,it,lg,pt}/settings.json` | a `users` block of six keys after `grants`; `lg` carries the English text |
| `docs/i18n/pending-luganda-translations.md` | one section appended |
| `.github/workflows/migrations.yml` | one step after the scoped-access write suite step |
| `scripts/test-linked-password-reset.js` | new edge suite |
| `web/react-gui/src/services/__tests__/api.adminUsers.test.ts`, `api.adminUsersExports.test.ts`, `web/react-gui/src/pages/__tests__/UsersPage.linkedReset.test.tsx`, `usersLocaleValues.test.ts` | new GUI tests |

## 6. Support files and custody

The support directory `docs/superpowers/plans/2026-10-29-issue-521-linked-reset-refusal/` holds the reviewed bytes as `<name>.txt`, so no tool collects or runs them in place. They are extracted to a scratch directory outside the worktree and run from there (`osi-flows-json-editing`: editors never run from the repository). Each editor and the custody checker refuses to run from inside the worktree.

| Name | SHA-256 | Role |
|---|---|---|
| `custody-521.js` | `6cbf8357e0873f21423dc4b822ee356a96cba1c2d555cfe9cfcc5aa1ae44f5cc` | Mandatory custody checker: writes and rechecks the input record, verifies every payload digest, extracts payloads, stages tests |
| `edit-flows-521.js` | `5357ed66c67656eba5d75c3d02fbd40dc32e3c23adf44b1be82ef4ce467c1837` | Flow and allowance editor; dry run by default |
| `edit-gui-521.js` | `47e5219999ad4e983d820f6631d8c747389795128c7b8b37de543ffdb2f42cae` | GUI, locale, tracker and CI editor; dry run by default |
| `scoped-admin-account-router.candidate.func.js` | `538bde95bd36d564b41662217fd6091eb5c86aa8ffef61a494245749b9b7fb1f` | Router body |
| `UsersPage.candidate.tsx` | `1b1c9976faf53230275ed5dc828b1bf149072a9a847ab20251eafc6f1381be37` | Page |
| `test-linked-password-reset.js` | `cee7cefa491835e47aa36525ef44b959e61fc0541719fc623fdbe83bd953f78d` | to `scripts/` |
| `api.adminUsers.test.ts` | `0d85b791e49837b0faa9bf7f0495546df98936da015250aa4a28173c73d4e206` | to `web/react-gui/src/services/__tests__/` |
| `api.adminUsersExports.test.ts` | `73d80647d42ea1095be3beacb11a66d10368ab4fef6a1f7c8dc28c0981a12b87` | to `web/react-gui/src/services/__tests__/` |
| `UsersPage.linkedReset.test.tsx` | `3bc0f2cf7eef9b8fa692b6c6c225c99dc415d76f934f2fbe626e1ca61bb0c6b1` | to `web/react-gui/src/pages/__tests__/` |
| `usersLocaleValues.test.ts` | `322431e6303e0b8e9a669458be8988967020eaf9c84dd8a6cc02e0809a58f238` | to `web/react-gui/src/pages/__tests__/` |
| `reconciliation.json` | recorded at materialization | The input record of the base; reviewed with this plan commit |

Every trusted digest is a constant inside the custody checker or an editor, or a Git object at M or N. Nothing is read from the environment or from a caller-supplied summary. The custody checker does not pin this document, and this document pins the custody checker, so there is no hash cycle.

Input classes in `custody-521.js`:

- Class S, exact bytes at M, any change stops the run: `osi-db-helper`, `osi-scope-helper` and `osi-installation-helper` (`index.js` and the `package.json` that selects it), `bcryptjs` (`package.json`, `umd/package.json`, `umd/index.js`) in both profiles; `UsersPage.tsx`; and fourteen flow nodes by `JSON.stringify` digest in both profiles (`admin-users-list-http`, `admin-users-create-http`, `admin-users-password-http`, `admin-users-disabled-http`, `scoped-admin-account-router`, `auth-response`, `auth-login-http`, `auth-login-func`, `auth-db-query`, `auth-process-result`, `auth-db-insert`, `auth-insert-complete`, `record-error-catch-auth`, `auth-catch-http500`). Also exact: the `node_modules/osi-db-helper` and `node_modules/osi-scope-helper` links in both profiles (mode 120000, targets `../osi-db-helper` and `../osi-scope-helper`), because `verify-sync-flow.js` loads the DB helper through the link before the direct path; the base-tree mode and object id of every class-S entry, equal to M; and a resolution guard: no `<dir>.js`, `<dir>.json` or `<dir>.node` beside any of the three helper directories, `node_modules/bcryptjs` or the two links, in the tree or the checkout, because Node tries those files before a directory's `package.json`.
- Class A, drift admitted only with its actual hash in the reviewed record and while the anchors hold: the seed (its users seam must keep its digest: users DDL, unique index, every trigger on `users`, `sync_outbox` and `scoped_access_emit` DDL), `farming.ts` (AdminUser anchor once), `api.ts` (edit anchors once; the request and response interceptors and `getApiErrorMessage` keep their digests), both harnesses, both `flows.json` files outside the fourteen nodes (each changed node id is recorded with its digest), the allowance file (no router entry; the identity verifier carries the current total pin once, followed by exactly one of the two reviewed label forms in section 11), every workflow file in `.github/workflows/` (a file added on the base is recorded), GUI `package.json` scripts, locales (round-trip, `grants` last, no `users`), the tracker, AGENTS.md, the playbook, and every gate script the tasks run: `verify-flows-fn-parse.js`, `test-flows-wiring.js`, `test-verify-flows-output-arity.js`, `verify-flows-output-arity.js`, `verify-flows-size-ratchet.js` and its baseline, `flows-size-scan.js`, `verify-no-new-silent-catch.js`, `flows-bare-require-scan.js`, `verify-no-stray-ddl.js`, `check-mqtt-topics.sh`, `verify-auth-flag-off-hermetic.js`, `verify-profile-parity.js`, `verify-sync-flow.js`, `verify-live-gateway-identity.js`, `verify-merge-allowance-preservation.js`, `verify-seed-db-ledger.js`, `verify-test-inventory.js` and its JSON, `verify-doc-hygiene.js` and its allowlist, `slop-check.js`, and the control suites of Task 2.
- Class A, programs run in child processes or handed to an interpreter (`EXEC_INPUTS`): the account-recovery CLI test's copied `scripts/account-recovery.js`, its `sqlite3.cjs` driver fixture and `--require` preload `resolve.cjs`; the ten `execFileSync` children and seven `runQuietNodeScript` children of `verify-sync-flow.js`; `repair-pi-schema.js` (from `test-history-helper.js`); `test-journal-bootstrap.js` and `test-strega-gen2-reconcile.js` (from `test-flows-wiring.js`); `test-identityd-service-lifecycle.sh` with the two `libexec` scripts it drives; `chirpstack-bootstrap.js`; `node-red.init` and the two `96_osi_server_config` files that `test-journal-v2-config.js` sources.
- Class A, helper packages loaded through computed paths (`MODULE_PACKAGES`, both profiles, `package.json` and `index.js`, plus `osi-journal/commands.js` and `osi-valve-control/live-authorize.js`): `osi-chirpstack-helper`, `osi-dendro-helper`, `osi-lib`, `osi-journal`, `osi-journal-replication`, `osi-command-ledger`, `osi-valve-control`, `osi-irrigation-policy`, `osi-rain`, `osi-matric-potential`, `osi-module-defaults`, `osi-entity-name`, `osi-scoped-access-commands`, `osi-history-helper`, `osi-history-router`.
- Class A, GUI inputs (`GUI_INPUTS`): the ES-import closure of the four new tests and the candidate page (31 files at M and N, among them `AuthContext.tsx`, `authSession.ts` and `authEvents.ts` behind the session harness), the build entry `index.html`, `src/main.jsx` and `src/i18n/config.ts`, and the tool configuration `.npmrc`, `tsconfig.node.json`, `postcss.config.js`, `tailwind.config.js` and `scripts/run-tsx-tests.mjs`, beside the `package.json`, lock, `tsconfig.json`, `vite.config.js` and `vitest.config.ts` already listed.
- The require closure: starting from the shared harness, the helper and `bcryptjs` entrypoints the harness and the edge suite load by directory or path, the module packages and programs above and every gate script, the checker follows each literal relative `require('./…')`, `require('../…')` or `require.resolve` of the same form, in `.js` and `.cjs` files, the way Node's CommonJS loader resolves it, hashes every file it reaches into the record, and stops on a dependency it cannot resolve. Files reached outside class S are class A.
- The tree rule (section 6.1) covers every other tracked file.

The record (`verify-inputs`) is written on a clean checkout of the base and holds that commit as `base`, every class-S and class-A digest, the class-S links, the changed flow nodes, the workflow list, the closure, every anchor, the ignored paths of the checkout and the tree record of section 6.1. Task 1 recomputes it on the plan commit (`recheck`): the commit must be the one the independent review accepted, its only parent must be `base`, it must add exactly the twelve plan files as regular files, every recorded digest and link must equal the Git object at `base`, and the recomputed record must equal the committed one in every field. Unrelated main movement before materialization is recorded and reviewed with the plan commit; any movement of a recorded input after that stops the run.

### 6.1 Tree rule and dispositions

`verify-inputs` records the base's root tree id, the reviewed main N, every gitlink in the base tree (any gitlink stops the run: its content is outside the record) and the complete raw tree diff from M to the base: for each changed path its status, both modes and both object ids, a class (`S`, `named` for a class-A input above, `tree` for anything else) and `reviewedAtN`. An entry is `reviewedAtN` when it is identical to an entry of the M to N diff, whose 38 entries the checker first reproduces against a fixed digest. A class-S entry in the diff stops the run. `needsReview` lists every entry that is not `reviewedAtN`.

The plan-commit review gives every `needsReview` entry one disposition and records it in its acceptance:

| Disposition | Meaning |
|---|---|
| `consumed-compatible` | A command of this plan reads the path (named, collected by `git ls-files`, a test directory, the GUI build or typecheck, or a path-built load); the reviewer read the diff and it changes none of this plan's anchors, seams, asserted behaviour or forecast counts |
| `not-consumed` | No command of this plan reads the path; the reviewer states why |
| `stop` | Anything else: a revised packet and a focused independent review are required |

Dispositions of the 38 M to N entries, from the packet's source review:

| Entries | Disposition |
|---|---|
| `migrations.yml`, `test-inventory.yml` | consumed-compatible: the CI insertion anchor holds once and the new runner entries stay; `verify-test-inventory.js` reads both |
| Luganda tracker | consumed-compatible: the editor appends after the existing sections, keeping the Advanced Schedule section |
| Seven `devices.json` locales, `AdvancedScheduleDrawer.tsx` and its test, `ValveScheduleDialog.tsx`, its two tests and fixture, `tests/f37Locales.test.ts` | consumed-compatible (typecheck, `test:unit`, build): none touches `settings.json`, `api.ts`, `farming.ts`, the Users page or the session modules; the f37 checks read fixed key lists with no `users.` key |
| `osi-valve-control/api.test.js` in both profiles | consumed-compatible: byte-identical in both profiles; no test of this plan loads it |
| Eight new or changed files under `scripts/` (`helpers/test-owned-scratch.js`, the two reconcile-ledger tests, `test-valve-ack-time-selector.test.js`, `test-apply-chameleon-calibration-seed.js`, the two watermark drydown files, the catch-up generator under `scripts/ops/`) and the two files under `tests/` | consumed-compatible: `verify-test-inventory.js` reads them through `git ls-files`; no command of this plan runs or loads them, and no script it runs names them |
| `CHANGELOG.md` and eight documents under `docs/` | consumed-compatible: read by the doc-hygiene scan (`git ls-files` over its scope) only; no script this plan runs names them, and this plan edits none of them |

The packet's source review (campaign report) lists all 38 paths with their object ids.

## 7. Conventions for execution

- Run every command from the worktree root unless the argv starts with `env -C web/react-gui`.
- `S` is a directory outside the worktree created before Task 1 (the campaign uses its owned scratch, never a shared `/tmp`); `TMPDIR` points at owned scratch too, because the edge suite writes its fixture databases under `os.tmpdir()`.
- `PLAN_COMMIT` is the full SHA of the plan commit named in the independent review's acceptance. It is the only value supplied from outside the repository.
- `B` is the base: the `base` field of the committed `reconciliation.json`, which Task 1.7 proves to be the plan commit's parent.
- Each command lists its inner deadline in seconds. Record the exit code of the command itself, never through a pipe.
- Stop and report on any output that differs from "Expected". Line-number drift is fine; content drift is not.
- Node 22.16 or later on the 22 line (CI pins `22`), or 24: the edge suite uses `node:sqlite` `isTransaction`.

### 7.1 Campaign wrapper

The release campaign runs every command of this plan, and of its materialization (appendix A), through one serialized heavy wrapper and the accepted capture controller. `C` is the campaign directory, outside the repository; its value and the capture controller's digest are recorded in the campaign report that carries this plan.

```bash
W="$(git rev-parse --show-toplevel)"            # the admitted worktree; never the root checkout
R="$C/reports/issue-521-impl-r1"                 # receipt root; the controller creates $R/<label>
X="$C/reports/issue-521-impl-r1-scratch"         # campaign-owned scratch
S="$X/support"
CAP="$C/reports/issue-436-runtime-base-execute-r1/capture.py"
step() { # label inner argv...
  local l="$1" i="$2"; shift 2
  local k=$(( i + 60 )); [ "$k" -gt 1800 ] && k=1800
  local o=$(( k + 2400 ))
  PYTHONDONTWRITEBYTECODE=1 TMPDIR="$X/tmp" timeout --signal=TERM --kill-after=10s "$o" \
    python3 "$C/run-heavy.py" python3 "$CAP" --worktree "$W" --receipt-dir "$R/$l" --label "521-impl-$l" \
    --timeout-seconds "$k" -- timeout --signal=TERM --kill-after=5s "$i" "$@" \
    > "$R.$l.outer.stdout" 2> "$R.$l.outer.stderr"
  echo $? > "$R.$l.wrapper.exit"
}
```

The capture deadline is the inner deadline plus 60 s (at most 1800 s, so no inner deadline above 1740 s is used). The outer deadline adds 2400 s for the serialized lane wait: one other owner's maximal 1800 s capture plus its teardown. Before each command the controller checks schema-2 pressure under 30 s old, `/proc` MemAvailable against the 8 GiB admission threshold, the guard's PID, PGID and SID and its start ticks, and the four activation digests; `run-heavy.py` serializes the commands. The campaign RAM policy applies throughout: 8 GiB to admit, 10 GiB to recover from a hold latch, and a registered command is stopped below 4 GiB; swap is diagnostic only. Receipts per step: `$R/<label>/{command.json,child.json,stdout,stderr,status.json}`, written by the controller (which creates `$R`), and `$R.<label>.outer.stdout`, `$R.<label>.outer.stderr` and `$R.<label>.wrapper.exit` beside it, so the first step needs no directory to exist. Keep every attempt. If the outer deadline expires while the command is still queued (wrapper exit 124 and no receipt directory), retry under a new label; never stop another owner's healthy command.

## 8. Tasks

Each row is run as `step <label> <inner> <argv…>` with the label shown (`t1.1` for step 1.1, and so on).

### Task 1. Prerequisites (no product change)

| Step | Command | Inner s | Expected |
|---|---|---|---|
| 1.1 | `node --version` | 10 | `v22.16.0` or later |
| 1.2 | `npm --version` | 10 | `10.9.0` or later |
| 1.3 | `git status --porcelain --untracked-files=all` | 10 | empty |
| 1.4 | `git rev-parse HEAD` | 10 | exactly `$PLAN_COMMIT` |
| 1.5 | `cp docs/superpowers/plans/2026-10-29-issue-521-linked-reset-refusal/custody-521.js.txt "$S/custody-521.js"` | 10 | exit 0 |
| 1.6 | `node -e "const h=require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex');if(h!==process.argv[2]){console.error('custody digest '+h);process.exit(1)}console.log('custody ok')" "$S/custody-521.js" 6cbf8357e0873f21423dc4b822ee356a96cba1c2d555cfe9cfcc5aa1ae44f5cc` | 10 | `custody ok` |
| 1.7 | `node "$S/custody-521.js" recheck docs/superpowers/plans/2026-10-29-issue-521-linked-reset-refusal/reconciliation.json "$PLAN_COMMIT"` | 120 | `custody-521: plan commit <PLAN_COMMIT> on base <B>: every recorded input unchanged`; any other output stops |
| 1.8 | `node -p "require('./docs/superpowers/plans/2026-10-29-issue-521-linked-reset-refusal/reconciliation.json').base"` | 10 | one SHA; this is `B` |
| 1.9 | `node "$S/custody-521.js" extract docs/superpowers/plans/2026-10-29-issue-521-linked-reset-refusal "$S/payloads"` | 30 | `custody-521: 9 payloads extracted to <S>/payloads` |
| 1.10 | `sqlite3 -version` | 10 | one `3.` version line; `verify-sync-flow.js` and its children call the `sqlite3` command (CI installs it) |
| 1.11 | `git --version` | 10 | one `git version` line; recorded with 1.1 and 1.2 as the tool versions of the run |

### Task 2. Base controls (product unchanged)

Every command must pass. A failure here is red on base: stop and report.

| Step | Command | Inner s | Expected |
|---|---|---|---|
| 2.1 | `node --test scripts/test-scoped-access-writes.js` | 600 | exit 0 |
| 2.2 | `node scripts/verify-scoped-access.js` | 300 | exit 0 |
| 2.3 | `node --test scripts/verify-scoped-access.test.js` | 600 | exit 0 |
| 2.4 | `node --test scripts/test-auth-bootstrap-policy.js scripts/test-account-recovery.js scripts/test-account-recovery-cli.js` | 600 | exit 0 |
| 2.5 | `env OSI_BASELINE_RUNNER=node-sqlite node --test scripts/test-auth-credential-isolation.js` | 300 | exit 0 |
| 2.6 | `env -C web/react-gui npm ci --no-audit --no-fund` | 900 | exit 0 |
| 2.7 | `env -C web/react-gui npm run typecheck` | 600 | exit 0 |
| 2.8 | `env -C web/react-gui npm run test:unit` | 1200 | exit 0 |
| 2.9 | `node .claude/skills/anti-slop-writing/slop-check.js docs/i18n/pending-luganda-translations.md` | 30 | record the tier-1 count (the base value for 5.17) |

### Task 3. Tests first

| Step | Command | Inner s | Expected |
|---|---|---|---|
| 3.1 | `node "$S/custody-521.js" stage-tests "$S/payloads"` | 30 | `custody-521: five tests staged` |
| 3.2 | `node --test --test-timeout=60000 scripts/test-linked-password-reset.js` | 900 | exit 1; `# tests 114`, `# pass 14`, `# fail 94`, `# skipped 6`; each test as in section 9 |
| 3.3 | `env -C web/react-gui npx --no-install vitest run src/pages/__tests__/UsersPage.linkedReset.test.tsx` | 300 | exit 1; 8 tests: 6 failed, 2 passed, as in section 9 |
| 3.4 | `env -C web/react-gui npx --no-install vitest run src/pages/__tests__/usersLocaleValues.test.ts` | 300 | exit 1; 3 failed |
| 3.5 | `env -C web/react-gui npx --no-install vitest run src/services/__tests__/api.adminUsers.test.ts` | 300 | exit 1; 10 tests: 4 failed, 6 passed |
| 3.6 | `env -C web/react-gui npx --no-install vitest run src/services/__tests__/api.adminUsersExports.test.ts` | 300 | exit 1 from the missing exports (import limitation, not a behavioural result) |
| 3.7 | `env -C web/react-gui npm run typecheck` | 600 | non-zero; errors only in `api.adminUsersExports.test.ts`, one per missing export (four) |
| 3.8 | `git add scripts/test-linked-password-reset.js web/react-gui/src/services/__tests__/api.adminUsers.test.ts web/react-gui/src/services/__tests__/api.adminUsersExports.test.ts web/react-gui/src/pages/__tests__/UsersPage.linkedReset.test.tsx web/react-gui/src/pages/__tests__/usersLocaleValues.test.ts` | 30 | exit 0 |
| 3.9 | `git commit -m "test: pin the linked-account password reset refusal (#521)"` | 30 | one commit, five files |

A failure for any reason other than the one forecast in section 9 is a stop.

### Task 4. Editors

| Step | Command | Inner s | Expected |
|---|---|---|---|
| 4.1 | `node "$S/payloads/edit-flows-521.js" "$S/payloads/scoped-admin-account-router.candidate.func.js"` | 60 | three `byte-identical: true` lines; `totals: base 1617501 -> head 1621080 (+3579); committed baseline 1616019 + delta 47589 = 1663608; head needs 5061`; `total allowance: unchanged (47589 covers 5061)`; the candidate line; `edit-flows-521: dry run OK (nothing written)`. On a later base the numbers follow section 11 |
| 4.2 | `node "$S/payloads/edit-flows-521.js" "$S/payloads/scoped-admin-account-router.candidate.func.js" --write` | 60 | the 4.1 lines, then six `byte-identical: true` lines in all; ends `edit-flows-521: OK (both profiles, the allowance file written)` (`... the allowance file and the identity pin written` on the raise branch) |
| 4.3 | `node "$S/payloads/edit-gui-521.js" "$S/payloads/UsersPage.candidate.tsx"` | 60 | twelve `ready` lines; `edit-gui-521: dry run OK (nothing written)` |
| 4.4 | `node "$S/payloads/edit-gui-521.js" "$S/payloads/UsersPage.candidate.tsx" --write` | 60 | `edit-gui-521: OK (12 files written)` |
| 4.5 | `git status --porcelain` | 10 | exactly the fifteen paths of step 6.1 marked modified (sixteen with the identity verifier on the raise branch) |

### Task 5. Candidate gates

| Step | Command | Inner s | Expected |
|---|---|---|---|
| 5.1 | `node --test --test-timeout=60000 scripts/test-linked-password-reset.js` | 900 | exit 0; `# tests 114`, `# pass 108`, `# fail 0`, `# skipped 6` (no generation column on this base); every mutant detected as in section 9 |
| 5.2a | `env -C web/react-gui npx --no-install vitest run src/pages/__tests__/UsersPage.linkedReset.test.tsx` | 300 | exit 0; 8 passed |
| 5.2b | `env -C web/react-gui npx --no-install vitest run src/pages/__tests__/usersLocaleValues.test.ts` | 300 | exit 0; 3 passed |
| 5.2c | `env -C web/react-gui npx --no-install vitest run src/services/__tests__/api.adminUsers.test.ts` | 300 | exit 0; 10 passed |
| 5.2d | `env -C web/react-gui npx --no-install vitest run src/services/__tests__/api.adminUsersExports.test.ts` | 300 | exit 0; 3 passed |
| 5.3a | `node --test scripts/test-scoped-access-writes.js` | 600 | exit 0; W8 local reset unchanged |
| 5.3b | `node scripts/verify-scoped-access.js` | 300 | exit 0 |
| 5.3c | `node --test scripts/verify-scoped-access.test.js` | 600 | exit 0 |
| 5.3d | `node --test scripts/test-auth-bootstrap-policy.js scripts/test-account-recovery.js scripts/test-account-recovery-cli.js` | 600 | exit 0 |
| 5.3e | `env OSI_BASELINE_RUNNER=node-sqlite node --test scripts/test-auth-credential-isolation.js` | 300 | exit 0 |
| 5.4 | `node scripts/verify-flows-fn-parse.js` | 120 | `verify-flows-fn-parse: OK` |
| 5.5 | `node scripts/test-flows-wiring.js` | 120 | ends `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed` |
| 5.6a | `node scripts/test-verify-flows-output-arity.js` | 120 | exit 0 |
| 5.6b | `node scripts/verify-flows-output-arity.js` | 120 | exit 0 |
| 5.7 | `env OSI_FLOWS_SIZE_BASE_REF="$B" node scripts/verify-flows-size-ratchet.js` | 120 | exit 0; `OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json (total 1621080)` and the same line for bcm2709; any `NOTE` lines; last line `verify-flows-size-ratchet: OK (HEAD total 3242160 <= <B> total 3235002; committed baseline not exceeded)`. The two totals are summed over both profiles; the printed `<=` is the script's fixed wording for the allowance-adjusted gate, not a comparison of these two numbers |
| 5.8 | `node scripts/verify-no-new-silent-catch.js` | 120 | exit 0 |
| 5.9 | `node scripts/flows-bare-require-scan.js` | 120 | exit 0 |
| 5.10 | `env OSI_DDL_BASE_REF="$B" node scripts/verify-no-stray-ddl.js` | 120 | exit 0 |
| 5.11 | `bash scripts/check-mqtt-topics.sh` | 60 | three `OK:` lines |
| 5.12 | `node scripts/verify-auth-flag-off-hermetic.js` | 300 | exit 0 |
| 5.13 | `node scripts/verify-profile-parity.js` | 300 | ends `All parity checks passed.` |
| 5.14 | `env OSI_FLOWS_SIZE_BASE_REF="$B" OSI_DDL_BASE_REF="$B" OSI_MIGRATIONS_BASE_REF="$B" OSI_IDENTITY_BASE_REF="$B" node scripts/verify-sync-flow.js` | 1700 | exit 0; prints `Sync flow verification passed` and ends with the chained parity script's `All parity checks passed.` |
| 5.15 | `node scripts/verify-test-inventory.js` | 120 | exit 0 |
| 5.16 | `node scripts/verify-doc-hygiene.js` | 120 | `verify-doc-hygiene: OK (...)` |
| 5.17 | `node .claude/skills/anti-slop-writing/slop-check.js docs/i18n/pending-luganda-translations.md` | 30 | tier-1 count equal to step 2.9 |
| 5.18 | `env -C web/react-gui npm run typecheck` | 600 | exit 0 |
| 5.19 | `env -C web/react-gui npm run test:unit` | 1200 | exit 0 |
| 5.20 | `env -C web/react-gui npm run build` | 900 | exit 0 |
| 5.21 | `git diff --check` | 10 | no output, exit 0 |

### Task 6. Commit

| Step | Command | Inner s | Expected |
|---|---|---|---|
| 6.1 | `git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-flows-size-ratchet-allowances.json web/react-gui/src/types/farming.ts web/react-gui/src/services/api.ts web/react-gui/src/pages/admin/UsersPage.tsx web/react-gui/public/locales/en/settings.json web/react-gui/public/locales/de-CH/settings.json web/react-gui/public/locales/es/settings.json web/react-gui/public/locales/fr/settings.json web/react-gui/public/locales/it/settings.json web/react-gui/public/locales/lg/settings.json web/react-gui/public/locales/pt/settings.json docs/i18n/pending-luganda-translations.md .github/workflows/migrations.yml` | 30 | exit 0 |
| 6.1r | `git add scripts/verify-live-gateway-identity.js` (raise branch only) | 30 | exit 0 |
| 6.2 | `git commit -m "fix: refuse local password reset for linked accounts (#521)"` | 30 | one commit, fifteen files (sixteen on the raise branch) |
| 6.3 | `git status --porcelain` | 10 | empty |

If the branch is ever brought up to date with a merge rather than a rebase, follow AGENTS.md "After an integration merge" before any gate: `node scripts/verify-merge-allowance-preservation.js --left-ref HEAD^1 --right-ref HEAD^2` and `node scripts/verify-seed-db-ledger.js`. #521 changes no schema and needs no seed rebuild.

### Task 7. Independent verification

Hand the final commit to a verifier who did not write it. The verifier re-runs Tasks 2, 3 (on the test commit), 5 and diffs every hunk against section 5. No pull request is opened from this plan without a separate instruction.

## 9. Forecast before the fix (UNRUN)

Edge suite, identical for each profile (52 tests per profile) plus 10 mutants:

| Test | Count | First failing assertion before the fix |
|---|---|---|
| linked v2, v1, hash, fallback | 4 | `<kind> reset status`: 200, expected 409 (the control login before it passes) |
| `temporary_password` alias | 1 | `alias reset status`: 200 |
| populated linked preservation, emit off and on | 2 | `populated reset status`: 200 (the population controls pass) |
| local reset controls, emit off and on | 2 | pass |
| hash and lock order | 1 | `bcrypt runs before the write lock`: no BEGIN |
| user list | 1 | `local row`: `auth_mode` undefined |
| create answer | 1 | `create answer`: `auth_mode` undefined |
| authorization and flag control | 1 | pass |
| validation control | 1 | pass |
| missing target | 1 | `missing: no bcrypt`: 1 call (status 404 and body already pass) |
| unknown sign-in type | 1 | `unknown status`: 200 |
| eight races after the preflight | 8 | `race status`: 200 (the hook has no preflight to follow) |
| linked then local again | 1 | `the hook fired after the preflight read`: none fired (status 200 passes) |
| affected-row: target became linked before the UPDATE | 1 | `affected-row status`: 200 |
| affected-row: target vanished before the UPDATE | 1 | pass: the old UUID-only UPDATE also answers 404 with zero rows |
| affected-row: eight `changes()` replacements | 8 | `affected-row status`: 200 |
| fault: preflight read error | 1 | `status`: 200 |
| fault: hash failure | 1 | `body`: `{message:"bcrypt exploded"}` leaks (status 500 already) |
| fault: busy write lock | 1 | `status`: 200 |
| fault: constraint-shaped UPDATE error | 1 | `status`: 409 with the SQL text |
| fault: commit refused | 1 | `status`: 200 |
| applied commit reported as failed | 1 | `applied-commit status`: 200 |
| count fault then ROLLBACK applied or refused | 2 | `rollback-failure status`: 200 |
| 401 or 403 inside the transaction with a failed ROLLBACK | 4 | `precedence status`: 200 |
| linked code on no other 409 | 1 | pass |
| #520 composition sentinel | 1 | pass (no column, no generation reference) |
| #520 composition cases | 3 | skipped (no `local_auth_generation` column) |
| mutants M1 to M10 | 10 | `mutant anchor occurs exactly once`: 0 (raised while the mutated flows are built, before either run) |

Totals: 114 tests, 14 pass, 94 fail, 6 skipped.

After the fix, each mutant test runs the shipped router and then the mutant on fresh fixtures, through the route without HTTP and with a 3 s race. The shipped run must complete (an integer status and a JSON object body), meet the oracle and fire exactly the arranged hooks. The mutant run must complete as well, fire the same hooks, miss the oracle and show its named regression; a timeout or a malformed answer is never counted as a detection. M5 is the one exception: its regression is the queued-facade deadlock, so its mutant run must time out. The named regressions:

| Mutant | Arranged hooks | Shipped answer | Mutant regression |
|---|---|---|---|
| M1 UPDATE without `auth_mode='local'` | target turns linked just before the UPDATE | 409 with the linked code | 200 and one reset UPDATE |
| M2 no preflight refusal | none | 409 with the code, no bcrypt | 409 with the code after one bcrypt call |
| M3 old UUID-only UPDATE, no target recheck | target turns linked after the preflight | 409 with the code, no reset UPDATE | 200 and one reset UPDATE |
| M4 `n >= 1` accepted | `changes()` reports 2 | the reset-failure 500 | 200 `{success:true}` |
| M5 `assertFreshRole(db, …)` inside the transaction | none | 200 `{success:true}` | timeout |
| M6 no token identity recheck | actor renamed after the preflight | 401, no reset UPDATE | 200 and one reset UPDATE |
| M7 linked refusal thrown | none | 409 with the code | the reset-failure 500 without a code |
| M9 every reset fault rethrown | constraint-shaped UPDATE error | the reset-failure 500 | 409 carrying the SQLite text |
| M10 rollback failure no longer outranks 401 | actor renamed after the preflight; ROLLBACK refused | the reset-failure 500 | 401 `Unauthorized` |
| M8 raw `auth_mode` in the list (HTTP) | none | `unknown` | `legacy-x` |

GUI, before the fix:

| File | Test | Before the fix |
|---|---|---|
| `UsersPage.linkedReset.test.tsx` | reset only on local rows | fails: `linked1` has a reset button |
| | older gateway | fails: two reset buttons |
| | exact linked refusal | fails: alert shows the server text, not the linked guidance |
| | generic 409 | fails at form retention: the old page closes the form (the alert text passes) |
| | server error | fails at form retention |
| | reload fails after success | fails: the alert shows the list error, not "may already have been applied" |
| | full success | passes (control) |
| | mismatched confirmation | passes (control) |
| `usersLocaleValues.test.ts` | three tests | each fails: no `users` block |
| `api.adminUsers.test.ts` | normalization | fails: raw values returned |
| | non-array list | fails: resolves |
| | create normalization | fails: `auth_mode` undefined |
| | success control | passes |
| | typed linked error | fails: error name `AxiosError` |
| | five untyped failures | pass (controls) |
| `api.adminUsersExports.test.ts` | three tests | fail because the four exports do not exist; this is an import limitation, not behavioural evidence |

## 10. Composition with #520

#520 (session revocation, a separate plan) edits the same router and adds `users.local_auth_generation`, a rotation trigger and an admission seam.

If #520 merges first, the custody checker stops: the router node, `auth-process-result`, the users seam and the router allowance entry all differ. A revised candidate and a focused independent review are then required before Task 3. The revision keeps #520's actor fence on the reset UPDATE and its `assertFreshRole` call, adds `AND user_uuid=? AND local_auth_generation=?` from `msg.req.osiLocalAdmission` to the transaction-local actor reread (a miss is 401), keeps the rollback precedence, replaces the router allowance delta with the exact measured growth over that base, and must pass the three composition tests with none skipped:

1. a committed local reset rotates the target's generation and no other account's;
2. a linked refusal and a proven rollback rotate nothing;
3. an actor generation rotated after admission is refused inside the reset transaction with 401 and no UPDATE.

The edge suite emulates the admission seam only when the column exists; if #520's merged admission differs, the revision replaces that emulation with #520's own admission code and keeps the three assertions. Adding the generation column to an allowed-change list is not a substitute.

If #521 merges first, #520 re-anchors on this branch. The sentinel test then fails until its reset transaction carries the generation recheck, and the three cases run on its branch.

## 11. Size accounting

The router grows from 10508 to 14087 characters (+3579) in both profiles. On this base the total goes from 1617501 to 1621080; the committed baseline 1616019 plus the standing delta 47589 covers it, so the total allowance and the identity pin do not change.

On a base where the standing delta no longer covers the head (for example after #356 sets the delta to exactly its own need), the flow editor computes `needed = headTotal - 1616019`, raises `total_allowance.delta` to exactly that value with an appended provenance sentence, and moves the strict pin in `scripts/verify-live-gateway-identity.js` and its two labels to the same value with a comment. Two reviewed label forms follow the pin: main's `'size total allowance: exact cumulative delta <n>'` / `'size total allowance: expected exact cumulative delta <n>'`, and the `'size total allowance: exact delta <n>'` / `'size total allowance: expected exact delta <n>'` block that #356's R4 editor writes. Exactly one form must follow the pin, once; the editor keeps that form and changes only the number, and it keeps every comment above the pin, the existing provenance and every other identity guard. If #356's reported delta of 6830 at a total of 1622849 holds, the head is 1626428 and the delta becomes 10409. The editor refuses when a router node allowance already exists. The baseline file is never rewritten.

## 12. Shared files with neighbouring work

| Work | Shared file | Its hunks | This plan's hunks | Rule |
|---|---|---|---|---|
| #520 | both `flows.json` | same router node, plus `auth-process-result`, `al-unlink-db`, `cs-reg-cloud-fn` | router only | section 10 |
| #520 | allowance file, seed, auth tests | router entry; generation column and triggers; credential isolation test | router entry; none; none | custody stops; section 10 |
| #443 | both `flows.json` | `cs-reg-cloud-fn`, `cs-reg-cloud-ack-fn` | router | node-disjoint |
| #443 | allowance file | replaces those two node entries, total untouched | adds the router entry | key-disjoint; re-run the editor on the new base |
| #443 | `migrations.yml` | inserts its step directly after the scoped-access write step | inserts this step after the same step | adjacent text; the later branch re-runs its editor, both steps stay |
| #443 | `scripts/test-scoped-access-writes.js` | ten anchored lines | none (run as a control) | none |
| #428 | both `flows.json` | `cancel-strega-actuation-fn`, `command-dedupe-dispatch` | router | node-disjoint |
| #428 | `web/react-gui/src/services/api.ts` | valve cancel functions | users block and one import line | hunk-disjoint; anchors and seams in section 6 allow it |
| #428 | allowance file | its node entries | router entry | key-disjoint |
| #356 | both `flows.json` | its scheduler and Chameleon nodes | router | node-disjoint |
| #356 | allowance file and identity verifier | total set to its need with its provenance, four node entries, the total pin with "exact delta" labels and the catch pin with its rationale | router entry; on the raise branch only the total, its provenance sentence, the pin number and a comment | section 11; #356's entries, labels form and catch rationale stay |
| #356 | seed and bundled databases | new schema through its migration | none | class A; the users seam must not change |
| #434, #519 | scope helper, recovery tool, last-admin SQL | none pending | none | controls only |

## 13. Limits

- The HTTP layer is a loopback emulation of the `http response` node; Node-RED's own HTTP node and catch dispatch are not exercised. Native Node-RED, the Pi image, the native `sqlite3` binding and Node 20 are not qualified by these tests.
- Injected COMMIT and ROLLBACK faults model reported failures, not real storage faults or power loss (WAL with `synchronous=NORMAL`).
- The zero-row branches that need a write between the target read and the UPDATE cannot occur under `BEGIN IMMEDIATE` with one writer; the tests inject them on the transaction connection.
- bcrypt cost 10 is observed at the call; the spy hashes at cost 4, so production latency is not measured.
- The named custody lists follow literal relative requires from the listed roots; a require built from a computed string is not followed. Completeness comes from the tree rule instead: every tracked change since M is in the record. The record does not bind files outside the worktree (a `node_modules` directory above it, for example), Git history beyond the base commit id, or the host tools; Task 1 prints Node, npm, `sqlite3` and Git versions, and the ignored paths of the checkout are listed. Tree entries are compared by Git's SHA-1 object ids; the named inputs also carry SHA-256 digests. `test-sync-history-schema.js` reads a seed from history and skips that check on a shallow clone.
- de-CH, es, fr, it and pt texts are author translations without native review; `lg` carries English by policy and is tracked.
- An older GUI keeps showing the reset form for linked rows and closes it after the 409.

## Appendix A. Materialization (already done when this file is read in the repository)

On a worktree created from fresh `origin/main`, before any product change, through the wrapper of section 7.1 with `PKT` the campaign packet's `proposed/plan` directory and `PLAN_SHA256` this document's digest as recorded in the campaign report:

| Label | Command | Inner s | Expected |
|---|---|---|---|
| m01 | `mkdir -p "$S" "$X/tmp"` | 10 | exit 0 |
| m02 | `git fetch --no-tags origin main` | 120 | exit 0 |
| m03 | `git rev-parse HEAD origin/main` | 10 | two equal lines; otherwise stop and recreate the worktree on fresh main |
| m04 | `git status --porcelain --untracked-files=all` | 10 | empty |
| m05 | `cp "$PKT/docs/superpowers/plans/2026-10-29-issue-521-linked-reset-refusal/custody-521.js.txt" "$S/custody-521.js"` | 10 | exit 0 |
| m06 | `node -e "const h=require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex');if(h!==process.argv[2]){console.error('custody digest '+h);process.exit(1)}console.log('custody ok')" "$S/custody-521.js" 6cbf8357e0873f21423dc4b822ee356a96cba1c2d555cfe9cfcc5aa1ae44f5cc` | 10 | `custody ok` |
| m07 | `node "$S/custody-521.js" verify-inputs --record "$S/reconciliation.json"` | 120 | exit 3 with drift and no failure (exit 0 only on M itself); exit 1 stops. On N: `drift` lists `.github/workflows/migrations.yml`, `.github/workflows/test-inventory.yml` and the Luganda tracker, `closure` 256, `classA` 310, `workflows` 11, `treeDiff` 38, `reviewedAtN` 38, `needsReview` empty |
| m08 | `node "$S/custody-521.js" materialize "$PKT" "$S/reconciliation.json" "$PLAN_SHA256"` | 120 | prints `base` (the m03 SHA), `plan` (`$PLAN_SHA256`), `custody` (`6cbf8357e0873f21423dc4b822ee356a96cba1c2d555cfe9cfcc5aa1ae44f5cc`), `reconciliation` and `paths: 12` |
| m09 | `node scripts/verify-doc-hygiene.js` | 120 | `verify-doc-hygiene: OK (...)` |
| m10 | `node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-10-29-issue-521-linked-reset-refusal.md` | 30 | `slop-check: PASS (no tier-1 findings)` |
| m11 | `node scripts/verify-test-inventory.js` | 120 | exit 0 (the `.txt` payloads are not test-named) |
| m12 | `git add docs/superpowers/plans/2026-10-29-issue-521-linked-reset-refusal.md docs/superpowers/plans/2026-10-29-issue-521-linked-reset-refusal` | 30 | exit 0 |
| m13 | `git diff --cached --check` | 10 | no output |
| m14 | `git diff --cached --name-only` | 10 | exactly the twelve plan paths: this document, `custody-521.js.txt`, nine payloads, `reconciliation.json` |
| m15 | `git commit -m "docs: plan the linked-account password reset refusal (#521)"` | 30 | one commit |
| m16 | `git rev-parse HEAD` | 10 | the plan commit; stop for the independent review bound to this SHA and its `reconciliation.json` |

The plan-commit review checks every drifted path in `reconciliation.json` against its Git object on the base, confirms that the `reviewedAtN` entries are the 38 dispositioned in section 6.1, gives every `needsReview` entry a disposition, reads the ignored paths, and only then names `PLAN_COMMIT` in its acceptance.
