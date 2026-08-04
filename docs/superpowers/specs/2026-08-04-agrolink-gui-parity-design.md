# AgroLink GUI parity design

Date: 2026-08-04. Status: approved by the maintainer in session; supersedes nothing.
Companion program: the edge/cloud functional parity program closed by
`docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-execution-report.md`.
This spec covers the GUI layer that program deliberately left out.

## Goal

An Agroscope user on https://agro-link.ch works through the same workflows, with
the same look, as a user standing in front of the edge GUI on the gateway. The
cloud frontend (osi-server `frontend/`) reaches functional and visual parity with
the edge GUI (osi-os `web/react-gui/`) for: zones, schedules and irrigation
calibration; devices including physical valve control; the full v10 field-journal
capture flow; history and analysis at edge depth; scoped-access administration.
The edge stays canonical for farm state. Every cloud mutation rides the existing
versioned-command and sync layer; this program adds no new sync surface.

## Non-goals

- Agroscope network-drive (Fola) access from the cloud. Edge-only by security
  decision (maintainer, 2026-08-04); the cloud GUI never references it.
- Terra pages, roots, or routes. The Terra production rehaul stream owns them
  and is executing concurrently; this program must not touch
  `frontend/src` Terra composition roots or collide with
  `feat/terra-rehaul-slice-*` work.
- Edge GUI behavior changes, with two exceptions: import-path moves to adopt
  `ui-core` (bundle-parity checked), and the grant-list API route that slice S5
  needs (a known gap: the edge admin GUI cannot enumerate existing grants).
- A cloud facade emulating the edge REST API. Considered and rejected: the
  facade would have to emulate about 130 edge routes plus the edge auth model,
  permanently.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Copy-adapt pages per slice; share only a vendored design core (`ui-core`) | Fast per-slice value; drift bounded where it is most visible (tokens, primitives) without refactoring the production edge GUI wholesale |
| D2 | `ui-core` canonical in osi-os, byte-mirrored to osi-server, CI-gated both sides | Same governance as the sync contract (`verify-edge-sync-contract-vendor`); the repo already trusts this pattern |
| D3 | Gateway context, not gateway chrome: one linked gateway means no selector anywhere; multiple linked gateways are switched on the Settings page | Maintainer decision 2026-08-04. Scoped accounts overwhelmingly see one farm; a header switcher would be dead weight |
| D4 | Capability-gated rendering | A page renders only what the selected gateway's capability handshake advertises; older gateways get an explicit "not available on this gateway" state, never a broken page |
| D5 | Fail-closed scope UX ported from edge | The cloud pages adopt the edge `ScopeContext` pattern (deny-while-loading, closed scope on profile-fetch failure) mapped to the cloud's 403-on-dormant convention |
| D6 | The cloud login screen keeps its current design (Swiss-cross badge, commit `5280da76`) and is excluded from visual parity | Maintainer decision 2026-08-04: the compact badge reads better than the edge login's letterhead treatment. The edge login stays as it is |

## The design core: `ui-core`

Canonical location `web/react-gui/src/ui-core/` (osi-os); vendored copy
`frontend/src/ui-core/` (osi-server). A byte-parity script on each side
(`scripts/verify-ui-core-vendor.*`, mirroring the sync-contract vendor check)
fails CI when the copies differ.

Contents, deliberately small:

- `tokens.css` — the single source of CSS custom properties. Merges the two
  existing `index.css` variable sheets (they already share `--bg`, `--card`,
  `--border`, `--error-bg`, `--error-text`, `--focus`) and carries the edge's
  liquid-glass set (`--glass-*`, `--chrome-*`, `--brand-red`) to the cloud.
  The known white-on-white `text-[var(--error-text)]` defect class (~30 files
  on the edge audit list) is fixed here once, at token level, and both GUIs
  inherit the fix.
- `tailwind-preset.js` — shared preset consuming the tokens; each repo's
  `tailwind.config.js` extends it.
- Eight primitives, no more: glass surface/card, button, chip/badge, modal,
  banner, form field, table shell, empty state. Page-level components stay
  per-repo. A primitive is admitted to `ui-core` only when both GUIs use it;
  single-sided components stay local.

Edge adoption is import-path moves plus deleting the superseded local styles.
Gate: the edge production bundle before and after adoption differs only in
hashed asset names (verified by building both and diffing rendered CSS/JS
content), and the full edge GUI suite (94 node tests + 1,671 Vitest at the time
of writing) stays green.

## Gateway context (cloud)

`GatewayProvider` resolves the account's linked gateways once per session.
One gateway: it is auto-selected; no selector exists in any chrome (D3).
Multiple: the Settings page gains a "Active gateway" section; selection persists
per account (localStorage keyed by user uuid) and the provider re-resolves
capabilities on switch. All parity pages consume `useGateway()` for scoping API
calls, capability gating (D4), and scope context (D5). Pages outside the parity
surface (account, cross-gateway dashboard, admin) ignore the provider.

## Slices

Each slice: port the edge pages and their components, wire to the existing
cloud APIs, extend the GUI-parity matrix, close with a side-by-side walkthrough
against the edge GUI on the test gateway (`agrolink-test-01`). A slice is not
done while its matrix rows lack walkthrough evidence.

| Slice | Scope | Notes |
|---|---|---|
| S0 | `ui-core` extraction + vendor gates + edge adoption + `GatewayProvider` + Settings switcher | No user-visible cloud change except tokens; the foundation everything else builds on |
| S1 | Zones, schedules, irrigation calibration | Mutations issue the existing versioned commands; conflict/rejection surfacing mirrors edge patterns |
| S2 | Devices incl. valve control | First GUI consumer of the physical-command authorization shipped 2026-08-04 (actor-carrying commands); resolves the deliberate device-list narrowing (weather shared-read devices appear in the list for scoped members, matching edge) |
| S3 | Field journal full capture | v10 catalog, operation-level scoping, copy-an-entry, denominator gate; replaces the current thin `JournalPage` |
| S4 | History and analysis | Gateway and zone history cards, drill-down routes, CSV export with paired pF rows, cross-zone analysis |
| S5 | Scoped-access administration | Users and grants management with parity on both sides; includes building the edge grant-list route and consuming it in both GUIs |

Slice order is dependency order: S0 blocks everything; S1 before S2 because
device views embed zone context; S3 through S5 are independent after S1 and may
be reordered on demand.

## Verification

- `docs/superpowers/plans/agrolink-gui-parity-matrix.md` (created in S0): one
  row per edge screen and load-bearing widget — edge source reference, cloud
  status (`missing` / `partial` / `parity`), walkthrough evidence link, and a
  dated provenance line per row. The API parity matrix went stale within a
  week of its baseline; the provenance requirement exists because of that.
- CI both repos: ui-core vendor byte-parity; the osi-server branding test
  extended over `ui-core` (no "OSI Cloud" token can enter shared primitives);
  per-slice unit suites and production builds.
- Valve actuation (S2) additionally requires a live test against
  `agrolink-test-01` with a short `OPEN_FOR_DURATION` before the slice closes;
  STREGA rules apply (no bare CLOSE).
- Each slice's walkthrough compares the edge GUI and the cloud page
  side-by-side on the same gateway and records deviations in the matrix.

## Coordination constraints

- The Terra rehaul Codex stream is live in `feat/terra-rehaul-slice-*`
  worktrees. This program works on the `AgroLink` branches only and does not
  modify Terra files; if a slice needs a file Terra also touches, the slice
  waits.
- osi-server `AgroLink` currently carries the scoped-access hardening and the
  rebrand; all GUI-parity work lands on the same pair of `AgroLink` branches,
  keeping the deploy-from-branch model intact.

## Risks

- The two frontends' component idioms have diverged (edge: single-page
  farming components with scope guards; cloud: thinner pages, some server
  admin surfaces). Copy-adapt cost per slice is real; the matrix rows keep the
  remaining gap honest instead of hiding it behind "route exists".
- ui-core admission discipline: if page-level components creep into the core,
  every edge GUI release couples to cloud release timing. The two-consumer
  admission rule (above) is the guard.
- Edge bundle-parity gate on S0 protects the production edge GUI from
  accidental visual regressions during token unification.
