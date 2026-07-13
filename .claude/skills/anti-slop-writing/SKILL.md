---
name: anti-slop-writing
description: Use when writing or editing any prose deliverable in this repo — files under docs/, README/AGENTS updates, ADRs, runbooks, PR or issue bodies, release notes, GUI copy, multi-line commit messages — before drafting begins; also when reviewing text that reads generic, padded, or machine-written.
---

# Anti-Slop Writing

## Overview

"Slop" is prose that signals machine generation: unearned significance, uniform
rhythm, stock vocabulary, decorative structure. This skill is the floor for all
documentation written in this repo.

Two principles order everything below:

1. **Structure before vocabulary.** Uniform sentence and paragraph length reads
   as AI even with every flagged word removed. Fix rhythm first, words second.
2. **Sharp detail beats inflated significance.** Importance is earned with
   mechanisms, numbers, and file paths, never asserted with adjectives.

Plain language is not slop. A document for non-technical readers follows every
rule here; it just chooses simpler nouns.

## The mechanical floor

Run the checker on every prose file you create or edit:

```bash
node .claude/skills/anti-slop-writing/slop-check.js <files...>
```

Pass signal: `slop-check: PASS (no tier-1 findings)`, exit 0. Tier-2 lines are
warnings — read each one and decide; do not bulk-suppress. The full word and
phrase lists live in the script (single source of truth); do not duplicate them
into prose. For a legitimate hit (quoted material, a domain term), append an
HTML comment `<!-- slop-allow: reason -->` on that line.

## Structure and rhythm rules

- **Vary sentence length deliberately.** A paragraph of same-length sentences is
  the strongest single tell. Follow a long compound sentence with a short one.
- **Claim, then proof.** Open the paragraph with the assertion; spend the rest
  on evidence (numbers, paths, behavior). Never build up to the point.
- **Front-load documents and sections.** The first sentence answers "what is
  this / what changed". Background follows.
- **No recap endings.** Do not close a section by restating it. End on the last
  fact. Conclusions, where needed at all, return to a concrete case and state
  what transfers.
- **Kill the rule of three.** Triads of adjectives, nouns, or clauses are
  filler symmetry. Use one precise item, or two, or an honest list of five.
- **Paragraphs relate explicitly.** Each paragraph continues the last by cause,
  contrast, dependency, inference, or a change of scope — and its first words
  should show which.

## Banned constructions

| Construction | Instead |
|---|---|
| Negative parallelism: `not just X, but Y`, `isn't X — it's Y`, `it wasn't A. It wasn't B. It was C.` | State Y directly. |
| Rhetorical setup: `Here's the thing:`, `Think of it as…`, `What if…?`, `Let's look at…` | Make the point without announcing it. |
| Dramatic fragmentation: `One file. That's it.` | Complete sentences; trust the content. |
| False agency: `the data tells us`, `decisions emerge`, `complaints become fixes` | Name the actor: the runner refuses, the trigger enqueues, the operator restarts. |
| Vague declaratives: `the implications are significant`, `the stakes are high` | State the specific implication or delete. |
| Copula avoidance: `serves as`, `stands as`, `acts as a` | Write "is". |
| Section-summary paragraphs, `In conclusion`, `Overall` | End on the last fact. |
| Editorializing significance: `plays a vital role`, `testament to`, `underscores the importance` | Show the dependency: what breaks without it. |

## Tone rules

- Neutral register; no marketing adjectives, no puffery, no cheerleading the
  reader ("you'll love", "simply", "just").
- Attribute claims to named sources or drop them. `Experts argue` and
  `industry reports` are weasel patterns.
- Prefer measured numbers to intensity adverbs: `polls every 30 s` beats
  `polls very frequently`. Delete intensifiers on sight.
- Active voice with the actor first, except where the actor is unknown or
  irrelevant.
- Hedge once, precisely (`counts drift as features land`), not reflexively
  (`arguably`, `essentially`, `in some sense`).

## Formatting rules

- Sentence-case headings ("Edge database", not "Edge Database" beyond the
  first word / proper nouns).
- Bold only for first-use definitions and genuine warnings — never for
  rhythmic emphasis, never the bold-term-colon list wall as a prose substitute.
- Em-dash budget: at most ~1 per 150 words (the checker warns above 8 per
  1000). Prefer commas, parentheses, or a new sentence.
- No emoji, no decorative horizontal rules, no skipped heading levels.
- Tables for enumerable facts; prose for reasoning. Never both saying the same
  thing.

## Red flags — stop and re-edit

- Every paragraph in a section is 2–3 sentences of similar length.
- A sentence exists only to introduce the next sentence.
- You cannot point to the fact a sentence adds.
- The word `comprehensive`, `robust`, or `landscape` survives in prose.
- More than one em-dash in a paragraph.

| Rationalization | Reality |
|---|---|
| "The banned word is accurate here" | Then keep it with `slop-allow:` and a reason. Unexplained hits fail. |
| "It reads fine to me" | Run the checker; read one paragraph aloud for rhythm. Familiarity hides tells. |
| "Docs need an engaging tone" | Engagement comes from specificity, not decoration. |
| "That rule is for marketing copy" | The tier-1 list came from encyclopedia and engineering-doc corpora, not ads. |

## Provenance

Ruleset merged and deduplicated on 2026-07-12 from: Wikipedia's
[Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)
(vocabulary eras, copula avoidance, negative parallelism, rule of three,
formatting tells), [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop)
(phrase categories, structure bans, five-dimension scoring),
[kjmagnan1s/anti-slop](https://github.com/kjmagnan1s/anti-slop) (structure-over-vocabulary
priority, tiered word floor, protect-list escape),
[adewale/anti-slop-writing](https://github.com/adewale/anti-slop-writing)
(paragraph-relation naming, concrete conclusions),
[realrossmanngroup/no_ai_slop_writing_rules](https://github.com/realrossmanngroup/no_ai_slop_writing_rules)
(sentence-length variance, number density, claim-then-proof),
[Byk3y/no-slop](https://github.com/Byk3y/no-slop) (linter framing). Re-check
those sources before extending the tier lists; vocabulary tells shift with
model generations.
