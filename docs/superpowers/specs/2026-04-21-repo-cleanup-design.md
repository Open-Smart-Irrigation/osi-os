# Repo Cleanup & Docs Reorganisation — Design Spec

**Date:** 2026-04-21
**Status:** Approved
**Scope:** Root-level markdown files + `docs/` directory restructure

---

## Goal

Remove stale implementation briefs from the repo root, consolidate completed AI-generated docs into a clear archive, and give `docs/` a self-describing structure with named categories.

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
├── README.md                    # Short index: one line per subdir, naming convention
├── build/
│   └── building-firmware.md    # Moved from BUILD-Readme.md
└── archive/
    ├── plans/                   # Completed implementation plans
    ├── specs/                   # Completed design specs (including this file)
    └── reviews/                 # Code reviews and audits
```

The `superpowers/` intermediate directory is removed — it was a tool name, not a meaningful category. Files move directly into `archive/{plans,specs,reviews}/`.

### Files moving into `archive/plans/`

| Source | Notes |
|--------|-------|
| `docs/superpowers/plans/2026-04-08-sensecap-s2120.md` | Completed |
| `docs/superpowers/plans/2026-04-18-lsn50v2-dendrometer-oversampling.md` | Completed |
| `docs/superpowers/plans/2026-04-18-lsn50v2-dendrometer-stock-shape.md` | Completed |
| `docs/superpowers/plans/2026-04-19-uganda-safe-repair-current-codebase-migration.md` | Completed |
| `docs/superpowers/plans/2026-04-21-battery-footer-standardization.md` | Untracked — commit here |
| `docs/superpowers/plans/2026-04-21-dragino-settings-ui.md` | Untracked — commit here |

### Files moving into `archive/specs/`

| Source | Notes |
|--------|-------|
| `docs/superpowers/specs/2026-04-08-sensecap-s2120-design.md` | Completed |
| `docs/superpowers/specs/2026-04-15-react-gui-bugfix-quality-design.md` | Completed |
| `docs/superpowers/specs/2026-04-18-lsn50v2-dendrometer-oversampling-design.md` | Completed |
| `docs/superpowers/specs/2026-04-21-battery-footer-standardization-design.md` | Completed |
| `docs/superpowers/specs/2026-04-21-repo-cleanup-design.md` | This file — archive after plan is written |

### Files moving into `archive/reviews/`

| Source | Notes |
|--------|-------|
| `docs/superpowers/reviews/2026-04-15-osi-os-full-audit.md` | Historical |

---

## `docs/README.md` Content

A short index explaining each subdirectory and the file naming convention (`YYYY-MM-DD-<topic>-<type>.md`). No more than 30 lines.

---

## Out of Scope

- `auxiliary/build-server/` — not doc-related, leave as-is
- `AGENTS.md` content — not changing, only reviewing for stale references as part of closeout
- `scripts/` — not changing

---

## Conventions Going Forward

- New specs → `docs/archive/specs/YYYY-MM-DD-<topic>-design.md`
- New plans → `docs/archive/plans/YYYY-MM-DD-<topic>.md`
- New reviews → `docs/archive/reviews/YYYY-MM-DD-<topic>.md`
- Build docs → `docs/build/`
- No `reference/` directory until there is something active to put in it
