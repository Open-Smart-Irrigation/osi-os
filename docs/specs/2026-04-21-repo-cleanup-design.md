# Repo Cleanup & Docs Reorganisation — Design Spec

**Date:** 2026-04-21
**Status:** Approved
**Scope:** Root-level markdown files + `docs/` directory restructure + superpowers skill path updates

---

## Goal

Remove stale implementation briefs from the repo root, reorganise `docs/` into named categories without tool-specific intermediaries, and update superpowers skill files to write to the new paths.

---

## Root-Level Changes

### Delete

| File | Reason |
|------|--------|
| `OSI-SERVER-INTEGRATION.md` | Task brief for completed cloud integration; references dead `feat/osi-server-integration` branch |
| `SECURITY_IMPLEMENTATION_PLAN.md` | Security plan for completed work; references `dendrov2` branch (long merged) |
| `temp/` | Empty directory, no value |

### Move

| From | To |
|------|----|
| `BUILD-Readme.md` | `docs/build/building-firmware.md` |

### Keep at root (unchanged)

`AGENTS.md`, `CLAUDE.md`, `README.md`, `Makefile`, `Jenkinsfile`, `deploy.sh`, `docker-compose.yml`, `Dockerfile-devel`, `feeds.conf.default`, `prepare_release.sh`, `LICENSE`, `auxiliary/`, `conf/`, `database/`, `feeds/`, `openwrt/`, `scripts/`, `web/`

---

## `docs/` Restructure

### Target layout

```
docs/
├── README.md          # Short index: one line per subdir, naming convention
├── build/
│   └── building-firmware.md
├── specs/             # Design specs (was docs/superpowers/specs/)
├── plans/             # Implementation plans (was docs/superpowers/plans/)
└── reviews/           # Code reviews and audits (was docs/superpowers/reviews/)
```

The `superpowers/` intermediate directory is removed — it was a tool name, not a meaningful category. Dated filenames carry the history; no separate `archive/` level needed.

### Files moving into `docs/plans/`

| Source | Notes |
|--------|-------|
| `docs/superpowers/plans/2026-04-08-sensecap-s2120.md` | Completed |
| `docs/superpowers/plans/2026-04-18-lsn50v2-dendrometer-oversampling.md` | Completed |
| `docs/superpowers/plans/2026-04-18-lsn50v2-dendrometer-stock-shape.md` | Completed |
| `docs/superpowers/plans/2026-04-19-uganda-safe-repair-current-codebase-migration.md` | Completed |
| `docs/superpowers/plans/2026-04-21-battery-footer-standardization.md` | Untracked — commit here |
| `docs/superpowers/plans/2026-04-21-dragino-settings-ui.md` | Untracked — commit here |

### Files moving into `docs/specs/`

| Source | Notes |
|--------|-------|
| `docs/superpowers/specs/2026-04-08-sensecap-s2120-design.md` | Completed |
| `docs/superpowers/specs/2026-04-15-react-gui-bugfix-quality-design.md` | Completed |
| `docs/superpowers/specs/2026-04-18-lsn50v2-dendrometer-oversampling-design.md` | Completed |
| `docs/superpowers/specs/2026-04-21-battery-footer-standardization-design.md` | Completed |
| `docs/superpowers/specs/2026-04-21-repo-cleanup-design.md` | This file |

### Files moving into `docs/reviews/`

| Source | Notes |
|--------|-------|
| `docs/superpowers/reviews/2026-04-15-osi-os-full-audit.md` | Historical |

---

## Superpowers Skill Updates

Six path references across five files in the plugin cache need updating from `docs/superpowers/…` to `docs/…`:

| File | Line | Change |
|------|------|--------|
| `skills/brainstorming/SKILL.md` | 29 | `docs/superpowers/specs/` → `docs/specs/` |
| `skills/brainstorming/SKILL.md` | 111 | `docs/superpowers/specs/` → `docs/specs/` |
| `skills/brainstorming/spec-document-reviewer-prompt.md` | 7 | `docs/superpowers/specs/` → `docs/specs/` |
| `skills/writing-plans/SKILL.md` | 18 | `docs/superpowers/plans/` → `docs/plans/` |
| `skills/writing-plans/SKILL.md` | 138 | `docs/superpowers/plans/` → `docs/plans/` |
| `skills/requesting-code-review/SKILL.md` | 61 | `docs/superpowers/plans/` → `docs/plans/` |
| `skills/subagent-driven-development/SKILL.md` | 131 | `docs/superpowers/plans/` → `docs/plans/` |

Plugin cache root: `/home/phil/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/`

Note: these are cache files and will revert if the plugin is updated. If that happens, re-apply these edits.

---

## `docs/README.md` Content

A short index explaining each subdirectory and the file naming convention (`YYYY-MM-DD-<topic>[-design].md`). No more than 30 lines.

---

## Out of Scope

- `auxiliary/build-server/` — not doc-related, leave as-is
- `AGENTS.md` content — not changing
- `scripts/` — not changing

---

## Conventions Going Forward

- New specs → `docs/specs/YYYY-MM-DD-<topic>-design.md`
- New plans → `docs/plans/YYYY-MM-DD-<topic>.md`
- New reviews → `docs/reviews/YYYY-MM-DD-<topic>.md`
- Build docs → `docs/build/`
