# Repo Cleanup & Docs Reorganisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove stale root-level docs, restructure `docs/` into flat named categories, and update superpowers skill files to use the new paths.

**Architecture:** Pure file-system reorganisation — `git rm` for deletions, `git mv` for tracked moves, direct edits for skill files in the plugin cache. No code changes.

**Tech Stack:** git, bash

**Spec:** `docs/superpowers/specs/2026-04-21-repo-cleanup-design.md`

---

### Task 1: Delete stale root-level files and empty temp/

**Files:**
- Delete: `OSI-SERVER-INTEGRATION.md`
- Delete: `SECURITY_IMPLEMENTATION_PLAN.md`
- Delete: `temp/` (empty directory)

- [ ] **Step 1: Delete tracked files and remove empty directory**

```bash
git rm OSI-SERVER-INTEGRATION.md SECURITY_IMPLEMENTATION_PLAN.md
rmdir temp
```

- [ ] **Step 2: Verify**

```bash
git status
```

Expected: two deletions staged, `temp/` absent from filesystem.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: delete stale root-level implementation briefs and empty temp/"
```

---

### Task 2: Move BUILD-Readme.md into docs/build/

**Files:**
- Delete: `BUILD-Readme.md`
- Create: `docs/build/building-firmware.md`

- [ ] **Step 1: Create target directory and move**

```bash
mkdir -p docs/build
git mv BUILD-Readme.md docs/build/building-firmware.md
```

- [ ] **Step 2: Verify**

```bash
git status
ls docs/build/
```

Expected: `docs/build/building-firmware.md` present, `BUILD-Readme.md` gone, one rename staged.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: move BUILD-Readme.md to docs/build/building-firmware.md"
```

---

### Task 3: Commit the two untracked plan files

These exist on disk but were never committed. Stage them before the restructure so git tracks the move in Task 4.

**Files:**
- `docs/superpowers/plans/2026-04-21-battery-footer-standardization.md` (untracked)
- `docs/superpowers/plans/2026-04-21-dragino-settings-ui.md` (untracked)

- [ ] **Step 1: Verify the files exist**

```bash
ls docs/superpowers/plans/2026-04-21-*.md
```

Expected: both files listed.

- [ ] **Step 2: Stage and commit**

```bash
git add docs/superpowers/plans/2026-04-21-battery-footer-standardization.md \
        docs/superpowers/plans/2026-04-21-dragino-settings-ui.md
git commit -m "docs: commit untracked plans for recently completed features"
```

---

### Task 4: Restructure docs/ — flatten superpowers/ into named categories

Move all content from `docs/superpowers/{specs,plans,reviews}/` to `docs/{specs,plans,reviews}/`, then remove the empty intermediate directory.

- [ ] **Step 1: Create target directories**

```bash
mkdir -p docs/specs docs/plans docs/reviews
```

- [ ] **Step 2: Move all specs**

```bash
git mv docs/superpowers/specs/2026-04-08-sensecap-s2120-design.md docs/specs/
git mv docs/superpowers/specs/2026-04-15-react-gui-bugfix-quality-design.md docs/specs/
git mv docs/superpowers/specs/2026-04-18-lsn50v2-dendrometer-oversampling-design.md docs/specs/
git mv docs/superpowers/specs/2026-04-21-battery-footer-standardization-design.md docs/specs/
git mv docs/superpowers/specs/2026-04-21-repo-cleanup-design.md docs/specs/
```

- [ ] **Step 3: Move all plans**

```bash
git mv docs/superpowers/plans/2026-04-08-sensecap-s2120.md docs/plans/
git mv docs/superpowers/plans/2026-04-18-lsn50v2-dendrometer-oversampling.md docs/plans/
git mv docs/superpowers/plans/2026-04-18-lsn50v2-dendrometer-stock-shape.md docs/plans/
git mv docs/superpowers/plans/2026-04-19-uganda-safe-repair-current-codebase-migration.md docs/plans/
git mv docs/superpowers/plans/2026-04-21-battery-footer-standardization.md docs/plans/
git mv docs/superpowers/plans/2026-04-21-dragino-settings-ui.md docs/plans/
git mv docs/superpowers/plans/2026-04-21-repo-cleanup.md docs/plans/
```

- [ ] **Step 4: Move all reviews**

```bash
git mv docs/superpowers/reviews/2026-04-15-osi-os-full-audit.md docs/reviews/
```

- [ ] **Step 5: Remove the now-empty superpowers/ tree**

```bash
rmdir docs/superpowers/specs docs/superpowers/plans docs/superpowers/reviews docs/superpowers
```

- [ ] **Step 6: Verify final structure**

```bash
find docs -type f | sort
```

Expected output (exact):
```
docs/build/building-firmware.md
docs/plans/2026-04-08-sensecap-s2120.md
docs/plans/2026-04-18-lsn50v2-dendrometer-oversampling.md
docs/plans/2026-04-18-lsn50v2-dendrometer-stock-shape.md
docs/plans/2026-04-19-uganda-safe-repair-current-codebase-migration.md
docs/plans/2026-04-21-battery-footer-standardization.md
docs/plans/2026-04-21-dragino-settings-ui.md
docs/plans/2026-04-21-repo-cleanup.md
docs/reviews/2026-04-15-osi-os-full-audit.md
docs/specs/2026-04-08-sensecap-s2120-design.md
docs/specs/2026-04-15-react-gui-bugfix-quality-design.md
docs/specs/2026-04-18-lsn50v2-dendrometer-oversampling-design.md
docs/specs/2026-04-21-battery-footer-standardization-design.md
docs/specs/2026-04-21-repo-cleanup-design.md
```

No `docs/superpowers/` directory remaining.

- [ ] **Step 7: Commit**

```bash
git commit -m "chore: restructure docs/ — remove superpowers/ intermediate, flatten to named categories"
```

---

### Task 5: Create docs/README.md

- [ ] **Step 1: Create the file**

Create `docs/README.md` with this exact content:

```markdown
# docs/

| Directory | Contents |
|-----------|----------|
| `build/` | Firmware build and development environment instructions |
| `specs/` | Design specs — one per feature, written before implementation |
| `plans/` | Implementation plans — step-by-step task breakdowns for agentic execution |
| `reviews/` | Code reviews and audit reports |

## File naming convention

```
YYYY-MM-DD-<topic>-design.md   # specs
YYYY-MM-DD-<topic>.md          # plans and reviews
```
```

- [ ] **Step 2: Stage and commit**

```bash
git add docs/README.md
git commit -m "docs: add docs/README.md directory index"
```

---

### Task 6: Update superpowers skill files

Seven path references across five files in the plugin cache need updating. These files are outside the git repo — no commit needed.

**Plugin cache root:** `/home/phil/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/`

> Note: these are cached files and will revert if the plugin is updated. Re-apply if that happens.

- [ ] **Step 1: Update skills/brainstorming/SKILL.md — 2 occurrences**

In `skills/brainstorming/SKILL.md`, replace every occurrence of:
```
docs/superpowers/specs/
```
With:
```
docs/specs/
```

Verify with:
```bash
grep -n "superpowers/specs" /home/phil/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/brainstorming/SKILL.md
```
Expected: no output.

- [ ] **Step 2: Update skills/brainstorming/spec-document-reviewer-prompt.md — 1 occurrence**

In `skills/brainstorming/spec-document-reviewer-prompt.md`, replace:
```
docs/superpowers/specs/
```
With:
```
docs/specs/
```

Verify with:
```bash
grep -n "superpowers/specs" /home/phil/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/brainstorming/spec-document-reviewer-prompt.md
```
Expected: no output.

- [ ] **Step 3: Update skills/writing-plans/SKILL.md — 2 occurrences**

In `skills/writing-plans/SKILL.md`, replace every occurrence of:
```
docs/superpowers/plans/
```
With:
```
docs/plans/
```

Verify with:
```bash
grep -n "superpowers/plans" /home/phil/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/writing-plans/SKILL.md
```
Expected: no output.

- [ ] **Step 4: Update skills/requesting-code-review/SKILL.md — 1 occurrence**

In `skills/requesting-code-review/SKILL.md`, replace:
```
docs/superpowers/plans/deployment-plan.md
```
With:
```
docs/plans/deployment-plan.md
```

Verify with:
```bash
grep -n "superpowers/plans" /home/phil/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/requesting-code-review/SKILL.md
```
Expected: no output.

- [ ] **Step 5: Update skills/subagent-driven-development/SKILL.md — 1 occurrence**

In `skills/subagent-driven-development/SKILL.md`, replace:
```
docs/superpowers/plans/feature-plan.md
```
With:
```
docs/plans/feature-plan.md
```

Verify with:
```bash
grep -n "superpowers/plans" /home/phil/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/subagent-driven-development/SKILL.md
```
Expected: no output.

- [ ] **Step 6: Final verification — no remaining superpowers path references in skills/**

```bash
grep -r "superpowers/specs\|superpowers/plans\|superpowers/reviews" \
  /home/phil/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/
```

Expected: no output.
