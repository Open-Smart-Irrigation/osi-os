# SDI-12 bench capture package execution

This slice adds a local capture-template generator, a pure evidence checker and
per-sensor bench procedures against base `f5ac5bf31`. It connects explicit recipe
inputs to raw serial timing and optional single-uplink comparisons. It changes no
runtime payload, schema, GUI, deployed recipe or hardware state.

Plan: [bench capture](2026-10-05-sdi12-bench-capture.md).
Usage: [capture and replay](../../devices/sdi12-bench-capture.md).

## Decisions and limits

Ruling: keep explicit serial and radio scopes, with no acquisition freshness or
stored-row/UI assertion. Existing helpers establish neither. The cost is another
capture schema version if future transport/persistence contracts need more fields.

Ruling: retain identity/calibration replies as uninterpreted bytes. Published
readback grammar does not justify accepting their meanings. The cost is a manual
review step until source-backed parsers are available.

The record labels bench versus synthetic evidence but authenticates neither.
All public outputs keep five qualification flags false. Templates contain no
invented observations. Successful checking requires structural completeness and
applicable timing/byte consistency, while leaving identity, settings applicability,
calibration and freshness unresolved. DATAUP=1 stays diagnostic. Original logs,
physical label/wiring photographs and later stored-row/API/UI evidence belong in
the run directory; this checker does not authenticate those artifacts.

Luna checked the reconciled sources and guide, independently recomputed the
58-byte PR2 radio payload, verified the equal-number leading-zero mutation and
TEROS example CRC. Root reopened the three primary manuals. The guide explicitly
labels the full wait after announcement receipt as a conservative checker policy,
not a claim about the earliest standard-permitted D request. Synthetic negative
fixtures have distinct capture IDs. Unknown radio session references can remain
null: the frame is retained, but missing session evidence prevents consistency.

## Review corrections

Astra's plan review required independent announcement-only timing inspection,
known time-order checks across null entries, and one owner for radio frame/binding
validation. The amended plan delegates protocol grammar to existing helpers and
compares raw record text in wire order using explicit slot bindings.

Root and Astra found that the first implementation still gated announcement
inspection on the full block shape. A null/malformed later block therefore hid a
provable early request. A failing regression demonstrated it; timing extraction
now depends only on the announcement fields, and block-array length checks also
survive malformed entries. The full transcript failure remains nested evidence.

Astra also demonstrated a JSON-compatible 5,000-level array that exceeded
structuredClone's stack before recipe validation. Direct and CLI regressions
failed first. Both public copy paths now guard cloning and return a bounded
invalid_capture refusal without echoing the malformed record.

Luna's unknown-session finding led to one contract refinement. A null session_ref
is now missing evidence, while blank/malformed references remain invalid. Root
observed RED against the previous strict metadata grammar and GREEN after the
change. It does not relax the successful-radio requirements.

## Verification

Terra authored the helper/direct tests; root authored CLI/fixtures/docs and the
null-session correction. Both helper and CLI suites first failed because their
implementation modules were absent. The final combined new suites pass 20 tests,
including all 12 synthetic examples, external-working-directory template/replay,
input-file bounds, byte-exact comparisons and the review regressions.

Root ran the exact updated offline SDI-12 command from
`.github/workflows/verify-sync-flow.yml`: 194 passed, zero failed, skipped,
cancelled or pending. Astra approved the frozen implementation with no remaining
findings, re-ran the 20 new tests, and independently probed 120 malformed-domain
substitutions, 11 behavior cases, seven correction cases and six nullable-session
cases. An additional probe checked detachment and no input mutation.

Changed prose passes the repository lint. Staged documentation hygiene passes on
414 files with built-in patterns only; the private name list was not supplied,
and allowlist staleness was not checked. Staged whitespace checks pass. Full sync
and hardware tests are outside this slice because runtime payloads are unchanged.
Sol independently ran the same offline command: 194/194 passed, with no material
finding. Its additional public-helper and external-working-directory CLI probes
checked deep JSON, null sessions, malformed-block timing, exact radio comparison,
detachment, templates and false qualification fields. One initial verifier
assertion assumed address0 for an addressA fixture; correcting that expectation
made the complete probe pass without an implementation change. All 11 non-null
fixture capture IDs are unique, and guide links resolve locally.
