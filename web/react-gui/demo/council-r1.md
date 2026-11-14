# Simulator council round 1 disposition

Reviewed head: `2ae1619e67016c493f5ac52ff1881bb9a788c3e6`.
Overall verdict: changes required. Passing automated gates did not establish
correct native Tab traversal, startup storage isolation or controller parity.

## Review results

- Independent Sol: changes required, 7/10. All requested gates passed, including
  378 model, 347 TSX, 3,390 Vitest, 26 presentation and 204 public browser tests,
  zero skips. Its additional probes reproduced the findings below.
- GLM: static review reported approve, 8/10, but included two should-fix items.
  Sol treats those items as unresolved changes, not release approval. GLM could
  not inspect images and ran no gates.
- Claude: API rate limit; no review or approval.
- Conditional Argon seat: not started because Go budget headroom was unverified.

The complete review reports and command logs are local artifacts under
`/tmp/osi-sim-council-r1/sol/` and `/tmp/osi-sim-council-r1/glm/`.

## Changes completed by the parent

1. Added the planned path-filtered source-only workflow that typechecks the
   demo, builds production/public/website artifacts and enforces isolation.
   The same commands passed locally. YAML parsed and the test-inventory guard
   passed; no hosted browser job was introduced.
2. Restored strict seven-locale key parity. The schedule-save confirmation now
   has an English Luganda resource tracked by the pending-human tests and doc.
   The redundant demo override was removed. Focused locale tests passed; no
   machine Luganda was added to production.
3. Corrected cancel `dropped_opens` to the edge's `{count, expectationIds}`
   shape. The cancelled target is not counted as its own collateral. Updated
   exact-reply regressions and the demo-only MeteoSwiss label. The two focused
   probes failed before their fixes; all 25 targeted tests passed afterward.
4. Reconciled the running-cancel and reset-language contract documentation and
   the unchanged CSV implementation disposition.

## Execution handoff

Luna has implemented SOL-R1-01 through SOL-R1-04 and GLM-N3 in this worktree.
The specific changes and evidence are recorded in the execution table in
`docs/superpowers/plans/2026-11-12-public-simulator-ux-polish.md`. The startup
storage probes passed for the public entry, and the public keyboard probe
reached the creation fields and compiled-week disclosure through normal Tab in
Chromium and Firefox. Final gates passed: demo model suite 381/381; demo and GUI
typechecks; shared modal tests 67/67; GUI TSX runner 347/347; GUI Vitest
3,391/3,391 across 306 files; presentation browser suite 28/28; and public
browser suite 213/213 across desktop Chromium, mobile Chromium and Firefox,
with zero skips. Production, public and website builds passed, and build
isolation passed (90 production files, 21 public files). Hygiene, test
inventory, AGENTS size and diff checks also passed. Detailed logs and the
keyboard screenshot are recorded in the execution plan.

The parent changes for the source-build CI, English Luganda fallback, locale
key parity, cancel reply shape and CSV/reset/cancel documentation remain in
place. No edge runtime, schema, sync, live credentials or website publishing is
added. A second independent Sol review and fresh affected gates must name the
resulting commit head before release approval. This execution does not claim
independent approval.
