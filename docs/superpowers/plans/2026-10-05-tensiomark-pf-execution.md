# Tensiomark pF preparation execution

Implemented the [approved pF preparation](2026-10-05-tensiomark-pf-preparation.md)
against base `6c83eabe7` on `feat/sdi12-profile-foundation`. The user selected pF
acquisition with edge conversion after the unit investigation. This slice changes
offline interpretation, unqualified legacy ingestion and the SDI-12 device card.
It does not activate acquisition, send probe commands, change schema or deploy.

## Result

Tensiomark candidate version 3 requires an explicit field order. Source indexes
match in the channel descriptor and hashed interpretation. Both declared orders
convert pF 4 to 1,000 kPa with no ceiling; pF 0 maps to 0.1 kPa and pF 7 maps to
1,000,000 kPa under the existing OSI log-hPa convention. Previous Tensiomark
versions, unknown order and pressure-unit inputs are refused. PR2/TEROS digests
remain unchanged.

The unversioned Tensiomark path emits battery only and preserves the exact decoded
input in quarantine. Its old field-order guess and clipping can no longer produce
new soil values. The candidate also preserves decoded text on refusal alongside
per-field diagnostics. These strings are not wire captures; the legacy codec may
already have removed converter/framing bytes. Bus/radio evidence remains separate.

The Tensiomark card displays the prepared 0.1..1,000,000 kPa range and derived pF.
Values above 300 have no VIA badge; invalid values, including zero, have none.
Other profiles keep their existing display limits. Zone summaries and irrigation
thresholds retain their existing range rules. Historical readings are not repaired
and cannot be qualified by selecting a new profile.

## Review and implementation evidence

Luna located the candidate/recipe/capture boundaries and affected fixtures. Terra
located the GUI consumers and implemented the two-file card change. Sol's plan
review required one shared source-position map, an early legacy refusal branch,
raw preservation, explicit old-version tests and scoped display validation.

Root wrote nine regression tests and observed nine failures against the previous
implementation. The first change passed seven; the order test caught a remaining
static index in the interpretation descriptor. Correcting that map made all nine
pass. Existing legacy expectations now assert quarantine deliberately. Terra
observed four expected rendering failures before its component correction; the
focused component suite then passed 23 tests.

Astra independently reviewed the final implementation and found no blocking issue.
It reran the normalizer and integration suites, checked 1,402 conversion/order
cases across pF 0..7, and tested exact decoded-string quarantine. It confirmed that
`normalizeConfigured` has only offline script/test callers and that shared SWT
classification is unchanged. Its independent GUI run passed both test runners.

## Verification

| Check | Root result |
|---|---|
| Normalizer tests | 54 passed, 0 failed |
| Full offline SDI-12 workflow command | 203 passed, 0 failed |
| Device integration, including two candidate SQLite rehearsals | 31 passed, 0 failed |
| Codec robustness | Passed |
| Raspberry Pi payload parity | All parity checks passed |
| GUI typecheck | Exit 0 |
| GUI unit tests | TSX: 219 passed, 1 skipped; Vitest: 2,272 passed in 212 files |
| GUI production build | Exit 0 |

The initial typecheck found no installed TypeScript executable. `npm ci` restored
the lockfile dependencies without changing the lockfile, then typecheck passed.
The package manager blocked esbuild install scripts; the packaged executables
still supported all checks and the build, so no script approval was needed.
GUI tests reported old browser compatibility data. The build reported its large
bundle warning. The TSX bundle-output assertion initially skipped because the
build was running concurrently; it is checked separately after build completion.
That post-build check passed all four tests, including the previously skipped
assertion. Changed prose passes the repository lint; its only advisory is the
actual verifier name containing “robustness”.
Documentation hygiene passed on 417 indexed files using built-in patterns only;
the private name list was not supplied and allowlist staleness was not checked.
The staged whitespace check passed.

Remaining bench work is model/firmware identification, pF-mode evidence, observed
field order, heating/freshness and converter fidelity. The candidate's provisional
and unavailable-acquisition flags stay fixed; declared settings cannot clear them.
