# Field Journal Slice 1 final-review correction report

## Result

All eight Important findings and Minor 2 are corrected. The maintained bcm2712
and bcm2709 runtime payloads are byte-identical, the focused regressions are
green, and the complete local gate matrix passes apart from the already-deferred
`origin/main` migration-number collision documented below.

No production host, live gateway, network service, or sister repository was
accessed. No branch was pushed, merged, rebased, or renumbered.

## Corrections

### IMP-1 — command replay identity and terminal ACK fidelity

- Added a deterministic `submittedIntentHash` over the command type, trusted
  owner and author provenance, logical mutation, and duplicate acknowledgement.
  Delivery IDs, lease data, and issue/expiry timestamps are excluded.
- Cross-delivery journal replay now requires exact intent, command type, owner,
  author, and gateway provenance. Legacy rows without the hash can replay only
  by exact delivery ID.
- New terminal ledger rows store the complete ACK object in `result_detail`.
  Exact delivery replay returns it verbatim. Rejections store `payloadHash:
  null` and expose the current aggregate hash separately when one exists.
- Duplicate-candidate details are safe camelCase fields. The single-entry
  acknowledgement is a canonical top-level command control and is removed
  before aggregate persistence.

### IMP-2 — batch duplicate preflight

- Batch entry creation accepts only a unique array of at most 100 canonical
  duplicate-candidate UUIDs.
- One transaction resolves every plot, collects every current candidate,
  rejects foreign acknowledgements, returns the complete unacknowledged set,
  and performs no writes until the preflight succeeds.
- Accepted controls are stripped before entry storage. The transaction rechecks
  candidates while creating each entry.

### IMP-3 — active layout version resolution

Code-only plot writes now bind the newest active layout version. Explicit
versions still require an exact active row. Command-originated plot writes no
longer force layout version 1.

### IMP-4 — CSV typing and reversibility

- Finite numeric cells are emitted as unquoted numbers.
- Wide CSV formula protection covers `=`, `+`, `-`, `@`, tab, and carriage
  return after ordinary spaces or non-breaking spaces, but applies only to
  strings.
- Research-package CSV preserves source strings exactly, including leading
  apostrophes and formula-like text.

### IMP-5 — fail-closed bootstrap manifest

Both bootstrap paths require these twelve tables before advertising Field
Journal capability: catalog state, entries and values, vocabulary and mappings,
plots and settings, plot groups and members, templates, layouts, and products.
Attachments remain outside Slice 1 readiness.

The version-1 manifest contains entry, custom-vocabulary, plot, and plot-group
counts plus a SHA-256 resource watermark. The hash concatenates UTF-8
`aggregate_type\0aggregate_key\0sync_version` tuples after bytewise sorting.
Final and voided entries and all custom vocabulary, plots, and groups participate,
including tombstones. Equal version sums with different resource states produce
different hashes.

The guarded flow migrator accepts the original preimage, interim, and installed
Task 12 hashes; produces the corrected pinned hashes; installs the `crypto`
function library where needed; rejects mixed states; and is idempotent. Both
maintained flow files were changed only through this migrator.

### IMP-6 — CI coverage

The Node 22 workflow now also runs API, command-path, bootstrap, read-snapshot,
catalog-generator, and generated-catalog checks. Checkout remains credential-free,
job permissions remain read-only, and no dependency-install step was added.

### IMP-7 — coherent multi-query reads

`listEntries`, `loadCurrentAggregate`, and `listPlotGroups` now assemble parent
and child rows inside one `readSnapshot`. Internal helpers avoid recursive fake
snapshot nesting. A real WAL interleaving test proves a reader observes either
the complete old generation or the complete new generation, and the stale-command
NACK test proves version and hash come from one snapshot.

### IMP-8 — custom vocabulary admissibility

- Kind-specific validation rejects irrelevant semantic and numeric fields,
  including crossed unit-only and attribute-only constraint metadata.
- Unit definitions require finite positive conversion scale, finite offset,
  dimension, and a scoped active self-canonical target in the same quantity,
  basis, and dimension family.
- Missing custom targets are structured retryable dependencies.
- Numeric attributes reuse the pure unit-family rules and require a canonical
  default unit when a default is present.
- Once used by any final or voided entry, including a tombstoned entry, unit
  dimension, target, scale, and offset are frozen.

### MIN-2 — asynchronous close errors

The journal HTTP facade rejects an error supplied to the SQLite close callback.
Its bounded warning path is exercised by the real HTTP handler.

## TDD evidence

- Command regressions first failed against the 43-test baseline on exact ACK
  replay, cross-delivery intent/provenance, safe rejection facts, and canonical
  duplicate controls. The final suite is 49/49.
- Bootstrap regressions first produced 26 expected failures against the old
  three-table, version-sum manifest. The final suite is 53/53.
- The WAL snapshot test failed before `readSnapshot` covered the public
  multi-query paths. The final helper suite is 4/4.
- Crossed unit/attribute constraints were accepted before the focused
  admissibility regression and rejected after the narrow validator change.
- The complete suite exposed stale flow-size allowances. They were updated to
  the measured intentional deltas only; the ratchet and all 14 negative tests
  then passed.

## Verification

Every command ran from the feature worktree on 2026-07-14.

| Area | Evidence |
| --- | --- |
| Journal modules | bcm2712 98/98; bcm2709 98/98 |
| Journal behavior | schema PASS; lifecycle 92/92; API 28/28; command 49/49; bootstrap 53/53; read snapshot 4/4 |
| Catalog | generator test PASS; two `--check` runs returned `e02911534785163669c0a546270017cac72fc1e6232c4c82f2da8848c38117fd` |
| Performance | 10,000 entries and 150,000 values; four named index plans; 50-row list max 21.916 ms; CSV 7,494,972 bytes; RSS growth 30.668 MiB |
| Schema and migrations | feature-base migration verification PASS for 17 migrations; seed replay PASS; seven bundled DB copies consistent; runtime schema parity PASS; migration engine 60/60 |
| Sync and contracts | sync flow PASS; schema contracts PASS; sync-op parity PASS plus 34/34 tests; sync contract, communication contract, and command safety PASS |
| Runtime/deploy | flow wiring, helper registration, profile parity, deploy migration 6/6, deploy atomic payload 6/6, history contract, and both history-helper 24/24 suites PASS |
| Ratchets | no-stray-DDL PASS at 702 markers; silent catches PASS at 229 per profile; flow size PASS at 1,036,554 function characters per profile; size tests 14/14; bare-require tests 7/7; MQTT topics PASS |
| CI surface | workflow structure PASS with Node 22, read-only credentials, and 12 exact run commands; 13 referenced files pass `node --check` |
| Final hygiene | profile mirrors byte-identical; prose checker and diff checks recorded after this report |

The Task 12 migrator was also exercised directly against historical preimage
`e2782c8f`, interim `c682be37`, and installed `b7aaffc2` flow bytes. Each produced
the corrected pinned functions and an idempotent second pass. A synthetic mixed
state was rejected.

## Known integration collision

`origin/main` at `749f77db6af7af1ea5148935259c58baff33fe4f` contains
`0014__improvement_request_status_secret.sql` with SHA-256
`b5196442091f2e151a67284ff65111664744803ead74067bb677d98db1ee0ad1`.
This feature contains `0014__field_journal.sql` with SHA-256
`0449e4699f6e67b5c7b7e579c4cfef5e4731b9098ecc9b2fe172269359ed48a6`.
Consequently, the repository-self-check in `verify-migrations.test.js` passes
6/7 cases and reports `base migration missing:
0014__improvement_request_status_secret.sql` against current `origin/main`.
The feature-base verifier passes. Per task scope, renumbering remains an
integration-time action after rebase and was not performed here.

## Scope and deferred work

The implementation surface is 22 tracked files: one workflow, two maintained
flows, ten mirrored journal module files, two contract files, and seven scripts.
This report and the requested progress ledger are force-added ignored artifacts,
bringing the commit scope to 24 files. No migration or bundled database changed.

Only the agreed deferred items remain:

- attachment constraints;
- `journal_products.updated_at`;
- migration numbering after integration with current `origin/main`.

## Follow-up: custom-vocabulary admissibility gaps

The follow-up review found three remaining paths that could admit unusable
custom terms. Choice creation checked only the parent kind, explicit-unit
attributes counted derived units without resolving their canonical targets,
and kind-specific constraint objects accepted unknown keys.

The public upsert now requires each choice parent to be visible, active,
undeleted, and a `choice` attribute. A missing well-formed custom parent returns
`missing_custom_dependency`; inactive, deleted, wrong-kind, and wrong-value-type
parents are permanent failures. Same-gateway parents owned by another user
remain hidden behind `404 not_found`.

`usableUnitPath()` is the pure unit-family check for both proposed units and
explicit-unit candidate scans. It requires an active source and target, a
self-canonical target with scale 1 and offset 0, and matching quantity, basis,
and dimension. The API builds the candidate map from all visible scoped units,
including inactive targets, before deciding whether any usable path remains.
Missing custom targets stay retryable; existing unusable targets fail
permanently.

Custom constraint JSON now has a closed grammar. Activity and choice terms,
plus choice, date, and boolean attributes, accept only null or an empty object.
Number attributes accept the six numeric keys already checked by
`numericConstraintsValid()`. Text attributes accept only an integer
`maxlength` from 0 through 4096. Unit objects accept only `dimension` and
`to_canonical`; the nested conversion accepts only `unit_code`, `scale`, and
`offset`. These checks apply only to custom upserts and do not change the
generated core catalog.

The RED run recorded four API failures (28/32 passed), two command failures
(49/51 passed), and the missing pure helper in the canonical module suite
(98/99 passed). The failures matched the review cases: wrong dependency reason,
inactive choice acceptance, open constraint objects, and a derived unit counted
after its identity target was retired.

After the correction, both module mirrors pass 99/99, the API passes 32/32,
and the command path passes 51/51. The command tests cover dependency arrival
on a new delivery, permanent inactive-parent and inactive-target rejection,
transactional no-write behavior, catalog reload, and exact derived-unit
conversion. Full sync flow, profile parity, helper registration, contract
schemas, communication contract, and command safety also exit 0. The stale
effect-key text now describes the shipped vocabulary, plot, and plot-group
handlers.

This follow-up did not change migrations, bundled databases, flows, workflow
files, the sister repository, or any live system. The existing migration-number
collision and the three deferred items above are unchanged.
