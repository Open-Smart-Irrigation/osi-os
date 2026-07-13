# Task 12 implementation report

## Outcome

Task 12 adds a fail-closed Field Journal compatibility advertisement to both
normal and forced edge bootstrap payloads. When the installed journal schema
and catalog state are valid, the gateway advertises `field_journal_v1`, the
catalog version and hash, and a bounded journal manifest. If readiness cannot
be proved, every journal-specific field is omitted while the ordinary
bootstrap continues.

The independent-review correction also makes all three Task 12 SQLite close
wrappers reject callback errors. The existing close catches can now report an
asynchronous SQLite failure instead of treating it as a successful close.

`/api/system/features` now returns `fieldJournalUxEnabled: false`. This flag
controls UI visibility only. Task 10 journal reads and exports, Task 11 command
handling and ACKs, stored journal data, and edge-to-cloud sync are unchanged by
its value.

No schema, seed database, React source, cloud service, or sister repository was
changed. No network, production gateway, or production server was accessed.

## Bootstrap contract

Both `Build Cloud Bootstrap` and `Run Force Sync` first verify that
`journal_catalog_state`, `journal_entries`, and `journal_vocab` exist. They then
require the `id=1` catalog row to contain a positive safe-integer version and an
exact lowercase 64-character hexadecimal hash. Only after those checks pass do
they add these fields to `gatewayIdentity`:

- `field_journal_v1` in `syncCapabilities`
- `journal_catalog_version`
- `journal_catalog_hash`
- `journal_manifest.entries_count`
- `journal_manifest.custom_vocab_count`
- `journal_manifest.high_water_mark`

The manifest counts final and voided entries, including tombstones, and all
custom vocabulary rows, including tombstones. Draft entries and core
vocabulary are excluded. The high-water mark is the sum of `sync_version` over
the same included rows. Every manifest value must be a non-negative safe
integer.

Missing tables or state, malformed catalog facts, and malformed manifest facts
suppress the complete journal advertisement. A query failure emits one
contextual warning whose database detail is capped at 200 characters, then the
core bootstrap proceeds with the existing linked-auth and force-sync
capabilities, prior gateway EUIs, and edge build version.

## Flow migration and catch visibility

`scripts/migrate-flows-journal-bootstrap.js` is the only writer for the two
maintained flow profiles. It pins node ID, name, type, original preimage
SHA-256, committed `c682be37` interim SHA-256, and corrected installed SHA-256
for the two bootstrap builders and `History API Router`. All three nodes must
match one pinned state; a mixed state is rejected. The script verifies JSON
byte round trips, checks the exact installed hashes, and accepts the installed
state as an exact no-op.

The migration also makes six empty catches visible in the touched nodes. An
absent history authentication-secret file remains an expected quiet `ENOENT`;
other read failures and all touched write, close, rewrite, and rollback failures
now emit contextual warnings. The silent-catch ratchet therefore falls from
235 to 229 in each profile. Flow-size allowances use the deltas measured by the
ratchet after the implementation.

The two bootstrap wrappers now reject the error passed to `_db.close` before
resolving. The history wrapper applies the same callback contract to
`db.close`. Their existing catches emit `Bootstrap DB close failed after
error`, force-sync operation context, and `History API DB close failed`
warnings respectively.

## TDD evidence

The behavior harness was added to `scripts/test-flows-wiring.js` before the
flow implementation. The focused RED run failed in both profiles because
normal and forced bootstrap exposed only the existing capabilities, the journal
fields were absent, query failures emitted no journal warning, and the feature
response lacked `fieldJournalUxEnabled`. The wiring gate ended with:

`FAIL: 1 flow wiring regression(s): - journal bootstrap behavior harness failed`

After the one-shot migration, all 22 original focused tests passed. The harness executes
the real function bodies for normal and forced bootstrap. It covers both
profiles, exact ready-state manifest values, draft exclusion, final and voided
tombstone inclusion, custom-vocabulary tombstone inclusion, absent tables,
missing state, uppercase hashes, zero and fractional versions, fractional and
negative manifest facts, bounded query-error warnings, preservation of the
core payload, the exact feature response, and the quiet `ENOENT` guard.

The independent-review test injects a callback error with `setImmediate`, so
the failure arrives after each `.close()` call returns. Before the correction,
the focused suite kept all 22 prior cases green and failed exactly three new
cases:

- normal bootstrap did not emit its close warning;
- forced bootstrap did not emit its force-sync warning;
- an authenticated unknown history route returned the expected 404 but did not
  emit its close warning.

After the migrator installed reject-on-error wrappers, all 25 focused tests
passed. The history case executes the real router through authentication and DB
open, skips only the already-applied schema guard, and reaches its real
`finally`; it is not a source-pattern proxy.

## Verification

All commands ran from
`.claude/worktrees/feat+field-journal-slice1` on 2026-07-13.

| Command | Result |
| --- | --- |
| `node scripts/test-journal-bootstrap.js` | PASS, 25 tests |
| `node scripts/test-flows-wiring.js` | PASS; journal harness and existing flow guards |
| `node scripts/verify-sync-flow.js` | PASS, including profile parity |
| `node scripts/verify-profile-parity.js` | PASS |
| `node scripts/verify-history-api-contract.js` | PASS |
| `node scripts/verify-no-new-silent-catch.js` | PASS; 229 in each profile |
| `node scripts/verify-flows-size-ratchet.js` | PASS |
| `node --test scripts/verify-flows-size-ratchet.test.js` | PASS, 14 tests |
| `node scripts/flows-bare-require-scan.js` | PASS |
| `node --test scripts/flows-bare-require-scan.test.js` | PASS, 7 tests |
| `node scripts/verify-no-stray-ddl.js` | PASS; unchanged total 702 |
| `scripts/check-mqtt-topics.sh` | PASS, three flow copies |
| `node scripts/test-contract-schemas.js` | PASS |
| `node scripts/verify-sync-contract.js` | PASS |
| `node scripts/verify-command-safety.js` | PASS |
| `node scripts/verify-communication-contract.js` | PASS |
| `node --test scripts/test-journal-api.js` | PASS, 22 tests |
| `node scripts/test-journal-command-path.js` | PASS, 43 tests |
| `node --check` on the Task 12 migration and harness | PASS |
| `git diff --check` | PASS |

The migrator was proved against both historical states. The original
`e2782c8f` input and committed `c682be37` interim input each produced exact
installed bytes with SHA-256
`354319661c728e6c1ce1a699b6acfc8236bdf96605464f974fa57b9c10419f44`.
Installed input returned an exact no-op, and a synthetic mixed state was
rejected. Two subsequent direct runs both reported
`migrate-flows-journal-bootstrap: already current`. The final maintained flow
files are byte-identical at 1,271,344 bytes each. No required Task 12
verification was skipped.
