# Cross-harness skill discovery and process parity

How the project skills reach each supported agent harness. This moved out of
`AGENTS.md` on 2026-10-22; `AGENTS.md` keeps a short summary and the rule to
read this page before changing the skill layout. This page carries the same
authority as `AGENTS.md`.

The 14 project skills in `.claude/skills/` load in all three
supported harnesses from one source. Claude Code reads `.claude/skills/`
directly. Codex reads the same files through the `.agents/skills` symlink (its
`.agents` convention); it does not read `.claude/skills`, so that symlink is
load-bearing. OpenCode scans both `.claude/skills` and `.agents/skills`,
walking up from the working directory.

Because OpenCode scans both roots and they alias to the same files, it logs one
`duplicate skill name` warning per skill at startup. The warning is cosmetic:
the skill still loads, keyed by its frontmatter `name`. OpenCode exposes no
config to disable a scan root, so deduping symlinked roots is an OpenCode-side
fix, not ours. Keep the single symlink; a second real copy to silence the
warning would drift from the first.

Process discipline comes from `docs/engineering-playbook.md` §2 (standard and
risk-class loops). On the maintainer workstation, user-level workflow skills
(`sol-loop`, `council`, `full-send`, `full-stop`, adapted from tstack) drive that
loop in Claude Code and Codex; they are not part of this repository, and no
harness here depends on the superpowers plugin. A harness without those skills
applies the same loop by hand. The `osi-*` skills cover the domain layer for
every harness.

## How each harness loads AGENTS.md

Codex injects only the first 32,768 bytes of `AGENTS.md` (observed across
the October 2026 sessions). `scripts/verify-agents-size.js` keeps the file at
or under 30,720 bytes and fails when a required section heading is missing or
starts past that offset; the doc-hygiene workflow runs it with its test.
When the check fails, move reference material into a doc or skill and leave a
one-line pointer in `AGENTS.md`.

Claude Code does not read `AGENTS.md` on its own. `CLAUDE.md` imports it with
an `@AGENTS.md` line, so every Claude Code session in this repository loads
the whole file.
