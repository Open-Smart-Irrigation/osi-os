# SDI-12 sensor recipe preview execution

This slice adds logical command plans for PR2/4, PR2/6, TEROS 11/12 and Tensiomark
variant 1 against base `3dbb19e5f`. Supplied exchanges are checked against the
selected measurement command and model count, then serialized and parsed again
under the existing converter model. HydraScout remains unavailable.

Plan: [sensor recipes](2026-10-04-sdi12-sensor-recipes.md).
Usage: [recipe preview](../../devices/sdi12-recipe-preview.md).

## Decisions and source checks

The generated plan contains SDI-12 commands, not fixed converter programming.
Actual grouping, startup timing and readback acceptance remain unresolved. A
later compiler step will be needed when those facts are established; this keeps
the logical command interface usable without asserting an unsupported deployment.

TEROS C/CC remains excluded despite documented forms because the current guide
describes nonstandard concurrent behavior. This limits the offline variants;
M/MC still exercises the documented measurement data. Tensiomark M is documented
and can be modelled without assigning its two raw fields to channel meanings.

Luna checked the primary PR2, TEROS and Tensiomark manuals against the audit.
Root independently checked TEROS CRC/concurrency, Tensiomark's minimum interval
and all three supply ranges. Luna then reviewed the guide/corpus and independently
recomputed the PR2 split example at 58 bytes and Tensiomark example at 22 bytes.
All 12 fixtures are synthetic; none is an installed capture. No manufacturer was
contacted and no unverified M3 readback parser was added.

Astra's preflight independently checked the capacity formulas. For PR2/6 at
hypothetical width nine, packed/maximum wrapped sizes are M76/96, MC82/114,
C72/97 and CC75/115 bytes. Its clarifications were adopted: zero-count refusal
preserves the underlying no-values diagnostic, and caller slot budgets describe
hypothetical retention capacity rather than installed firmware support.

## Implementation and verification

Terra owns the pure helper/direct tests; root owns the CLI, synthetic corpus,
documentation and CI entry. The root CLI suite first failed all three tests
because the executable did not exist, then the CLI was implemented against the
reviewed helper interface. Existing runtime normalizers and Sentek recipes are
unchanged; the new tool never normalizes raw vectors into canonical channels.

Terra's direct suite first failed on the absent helper, then passed after
implementation. Astra found that the draft checked announced wait only after
protocol completion. A failing regression reproduced the issue; the helper now
refuses an interval shorter than a valid announced wait even on incomplete or
aborted transcripts, preserving the underlying protocol diagnostic. The corpus
also gained explicit source locators during review.

Astra approved the final slice with no material findings remaining. Its independent
probes covered 4,202 cases across supported profiles/families, widths 2–9, legal
reply groupings, exact byte/slot budgets and one below each, raw CRC preservation,
malformed input and immutability. Thirteen separately calculated capacity rows
also passed. Helper and CLI suites passed 13 tests, including all 12 fixtures.

Root ran the exact updated offline SDI-12 CI command from
`.github/workflows/verify-sync-flow.yml`: 174 tests passed, zero failed, skipped
or cancelled. Sol independently ran that same command with the same result,
verified the 58-byte PR2/6 example from outside the checkout, and passed 17 groups
of independent command, capacity, budget, malformed-input, supply, refusal and
immutability probes. Its two initial test expectations were corrected to respect
the existing Tensiomark minimum-interval and variant-refusal contracts; neither
required a code change. Sol found no material issue.

Changed Markdown passes the prose lint. Staged documentation hygiene passes across
411 files using built-in patterns only; the private name list was unavailable and
allowlist staleness was not checked. Staged whitespace checks pass. Full sync and
hardware checks are outside this offline-only slice.

## Remaining work

The model assumes the converter retains the announcement and every complete D
reply in caller-assigned slots. It does not prove command application, timing,
firmware compatibility, value meaning or sample freshness. Tensiomark response
order and PR2 calibration acceptance still require stronger evidence. The next
bench package must preserve these unresolved facts alongside captured commands,
readbacks and raw radio bytes before fixed converter recipes can be qualified.
