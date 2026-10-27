---
name: osi-session-closeout
description: Use when the user says "finish the session".
---

# OSI session closeout

Moved from `AGENTS.md` on 2026-10-27; it carries the same authority.

When the user says `finish the session`:

1. Run `git status --short --branch` and report staged/unstaged/untracked.
2. Remove only clearly temporary files. List ambiguous files as cleanup candidates instead of deleting them.
3. Review and update `AGENTS.md` for durable repo-level changes.
4. Record cross-session operational context in the memory store of the harness you are running in (Claude Code: its auto-memory for this repo). A harness without a memory store writes it to the run's `HANDOVER.md` under `.superpowers/sdd/<run>/` and says so in the closeout report. Never edit another harness's memory files. A rule every harness must follow goes into `AGENTS.md` or a repo skill by PR, not into memory.
5. Run `scripts/session-closeout.sh` (`OSI_OS_MEMORY_FILE=<your memory index>` opts into a memory check) and report warnings.
6. If no context files needed changes, say so explicitly.
7. End with remaining risks, skipped verification, and the next recommended step.

Keep closeout updates factual. Never delete ambiguous files without asking.
