<!-- Definition of done — from docs/engineering-playbook.md §8. Delete lines that
     genuinely don't apply; don't delete lines that are merely inconvenient. -->

## What & why

<!-- Root cause (for fixes) or motivation (for features). Link the issue:
     "Fixes #NNN". If the issue's claim differed from reality, say what you
     actually found. -->

## Design decisions & tradeoffs

<!-- The choices a reviewer would question, each with its rationale. Deliberate
     deviations and accepted limitations belong here, not in silence. -->

## Checklist

- [ ] Issue/claim **re-verified against current `main`** before work started
- [ ] Plan + review live in `docs/superpowers/plans/` (non-trivial changes)
- [ ] Tests exist that **fail without this change** (TDD or regression pins)
- [ ] All gates green, **re-run by someone/something other than the author**
      (`verify-sync-flow.js`, migration verifiers, GUI typecheck + test:unit + build — as applicable)
- [ ] bcm2712 payload changes mirrored **byte-identically** to bcm2709
- [ ] No fabricated defaults: missing data renders as missing, never as a plausible value
- [ ] Schema changes via **ordered migrations only** (boot-DDL node untouched); seed/bundled-DB parity held
- [ ] Stale docs/AGENTS.md touched by this change corrected in the same PR
- [ ] Follow-ups I chose not to do are **filed as issues** and linked below

## Verification evidence

<!-- Paste the actual gate outputs / test counts. "It works" without output is
     a claim, not evidence. -->

## Follow-ups

<!-- Issue links, or "none". -->
