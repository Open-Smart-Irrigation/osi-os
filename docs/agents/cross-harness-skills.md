# Cross-harness skill discovery and process parity

How the project skills reach each supported agent harness. This moved out of
`AGENTS.md` on 2026-10-22; `AGENTS.md` keeps a short summary and the rule to
read this page before changing the skill layout.

The 14 project skills listed in `AGENTS.md` ("Agent skills") load in all three
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

Process discipline comes from the superpowers skills where a harness has them
installed (on the maintainer workstation: Claude Code, and Codex through its
plugin and `~/.agents/skills`). A harness without them
applies the same loop by hand from `docs/engineering-playbook.md`. The
`osi-*` skills cover the domain layer for every harness.

## How each harness loads AGENTS.md

Codex injects only the first 32,768 bytes of `AGENTS.md` (observed across
the October 2026 sessions). `scripts/verify-agents-size.js` keeps the file at
or under 30,720 bytes and fails when a required section heading is missing or
starts past that offset; the doc-hygiene workflow runs it with its test.
When the check fails, move reference material into a doc or skill and leave a
one-line pointer in `AGENTS.md`.
