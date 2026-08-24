# Bovey cloud↔edge parity: design

**Status:** draft for independent review. §4 decisions are open; §5 onward is
contingent on them.

**Driver:** the Bovey gateway is live and syncing to `bovey.cloud`, but the cloud
instance shows stock OSI branding, has no valve surface at all, and no general
settings page. A customer presentation is scheduled this week.

**Related:** `2026-08-19-valve-control-design.md` (Phase A, shipped),
`2026-08-23-valve-cloud-parity-phase-b-design.md` (sync parity — its ruling D4
**stands** under this spec), `2026-08-24-valve-advanced-controls-consolidation-design.md`.

---

## 1. Verified current state

Measured 2026-08-24 ~20:00 UTC against the live instance, not inferred.

**Sync works.** This contradicts the initial report and changes what must be
built:

| Signal | Value |
|---|---|
| Gateway `last_seen` | seconds old, continuously refreshed |
| `sensor_data` rows | 504, newest within 4 minutes |
| `sync_inbox` | events arriving every ~3 minutes |
| `valve_schedules` edge → cloud | 3 → 3, exact match |
| `sync_dead_letter` | **0** |

**What is missing:**

| # | Gap | Evidence |
|---|---|---|
| G1 | Stock branding | `<title>OSI Irrigation Cloud</title>`; `bovey-backend` built from `feat/valve-schedule-cloud-parity`, which has none of the 5 branding commits |
| G2 | No valve REST surface | `/api/v1/valves` → 404, `/api/v1/valve-schedules` → 404; no valve controller exists |
| G3 | No valve UI | Cloud has only the legacy `StregaValveCard`; the edge has 9 components |
| G4 | No general settings page | Edge has `pages/SettingsPage.tsx` at `/settings` (685 lines); cloud has **zero** settings pages and no `/settings` route |
| G5 | Ownership confusion | `bovey-admin` (id 1, SUPER_ADMIN) owns nothing; `admin` (id 2, USER) owns the gateway, all 3 devices, both zones |

**Consequence of G2:** valve schedules replicate into Postgres correctly and are
then unreachable by any client. The parity branch is backend-only — 985 lines of
Java, migration and tests, **zero frontend changes**.

## 2. Three structural facts

**(a) Branding and parity branches do not overlap.** Both fork from `main`
@ `8cac33d3`; branding touches 31 files, parity 15, intersection **empty**. The
combined branch is a clean merge, not a reconciliation.

**(b) `ui-core` is edge-only.** It exists at `web/react-gui/src/ui-core/`
(4 primitives) in osi-os and is **not** vendored into osi-server. The AgroLink
parity programme used vendoring as its sharing mechanism; that mechanism does not
exist here, so any UI port is manual today.

**(c) The edge settings page is mostly gateway-local.** Of its sections — display
preferences, module enable/disable, gateway timezone, scheduler control, support
request — only display preferences and the support request are meaningful in a
cloud context. Module toggles and gateway timezone govern gateway hardware and
have no cloud counterpart. **A faithful port would ship dead controls.**

## 3. The constraint that governs everything

**The edge is authoritative for valve state** (ruling D2). No cloud→edge event
mirror exists — `recordOutboxMirror` is dead code. Cloud→edge influence travels
only as commands through `device_commands`, polled by the gateway every 30 s.

A cloud valve UI is therefore, by construction, a **view onto edge-owned state**.
The question is not whether the cloud can own valve state — it cannot — but how
much write capability is worth building on the command channel.

## 4. Decisions for independent review

### C1 — Scope of the cloud settings page

**Options:** (a) port the edge page faithfully, disabling gateway-only sections;
(b) build a cloud-appropriate settings page carrying only what the cloud can
actually govern — display preferences, language, account-adjacent controls, and
the support-request form; (c) extend the existing `/account` page rather than
adding `/settings`.

**Evidence:** §2(c). Gateway timezone and module toggles are gateway state
reached through commands, not cloud state. (a) ships controls that either do
nothing or silently fail. (c) avoids a new route but conflates identity with
preferences, and the operator asked for a settings button.

**Recommendation: (b).** Ship a settings page that is honest about what the cloud
owns. Gateway-governed settings are surfaced read-only, clearly labelled as
gateway state, or omitted entirely — never as controls that appear to work.

**If wrong:** we build a second settings surface later when cloud→edge settings
commands land.

### C2 — How much write capability does the cloud valve UI get?

**Options:** (a) read-only — cloud shows schedules and state; authoring stays on
the gateway; (b) writes dispatched as commands through `device_commands`, edge
applies and syncs back; (c) cloud writes its own table — **rejected**, breaks D2.

**Evidence for (a):** a fraction of the work, cannot corrupt edge state, and
matches what the presentation needs. **For (b):** a farmer who can only look at
schedules will ask why, and the command channel is already proven for open/close.

**Recommendation: (a) for this session, built so (b) is additive** — components
take an `editable` capability flag defaulting to false; no read path assumes
immutability. Shipping (b) under time pressure risks the one thing that must not
break: the edge's authority over what a valve does.

**If wrong:** the demo is read-only and writes land next week.

### C3 — How does the valve UI reach the cloud frontend?

**Options:** (a) port the 9 edge components manually into
`frontend/src/components/farming/valves/`; (b) vendor `ui-core` into osi-server
first, then port against it; (c) build a cloud-native read view sharing no code.

**Evidence:** (b) is the right long-term answer but is a second programme —
`ui-core` is 4 primitives and the valve components depend on far more. (c)
guarantees drift.

**Recommendation: (a) now, (b) tracked as follow-up.** Port faithfully, keep
component names identical so a later extraction is mechanical, and record the
divergence risk rather than pretending it does not exist.

### C4 — Does `StregaValveCard` survive in the cloud?

The cloud has the same two-surface problem #171 describes on the edge. Adding a
valve panel beside the legacy card reproduces it.

**Recommendation: the new panel owns valve operation; the legacy card's valve
controls leave the cloud daily path in the same change.** Deferring means
shipping the confusion to a customer first.

### C5 — The demo account

`admin`/USER owns everything; `bovey-admin`/SUPER_ADMIN owns nothing. A
presentation that logs in as "admin" against a stock-titled page undercuts the
branding work.

**Recommendation: rename the owning account; leave ownership untouched.**
Re-owning rows spans `claimed_by_user_id`, zone `user_id` and
`linked_gateway_accounts` atomically and risks orphaning live sync for cosmetics.
**Do not re-own.**

## 5. Scope under the recommended answers

**This is a cloud-only programme. No edge changes, no gateway migration.**
Ruling D4 stands: `valve_settings` remains edge-only, so the cloud valve surface
does not show generation, flow rate or default-open minutes. That is a stated
limitation, not an oversight.

**In:** combined osi-server branch (branding + parity); cloud `ValveController`
exposing list / schedules / state as reads; the valve components ported
read-only behind an `editable` flag; legacy card's valve controls removed from
the cloud daily path; a cloud-appropriate `/settings` page; account rename;
rebuild and redeploy `bovey-backend`.

**Out:** cloud→edge schedule authoring (C2b); `ui-core` vendoring (C3b);
`valve_settings` sync (D4 stands); re-owning data (C5); **any change to the edge**,
whose valve UI is shipped and working.

## 6. Verification

- `/api/v1/valves` and the schedule routes return 200 with data matching the
  gateway's own `/api/valves` for the same EUIs.
- A schedule created on the gateway appears in the cloud UI without manual steps.
- `sync_dead_letter` stays at 0 across the whole exercise.
- `bovey.cloud` serves the Bovey title and palette.
- `/settings` is reachable, and every control on it does something real.
- The gateway is untouched — verified by re-running the edge gates, not by
  inspection.
- Existing osi-server suites stay green, including `SyncApplierDispatchIT`.

## 7. Open items

- `ui-core` vendoring into osi-server (C3b) — the real fix for edge/cloud UI drift.
- Cloud→edge schedule authoring (C2b) and settings commands (C1 follow-up).
- Whether the six advanced STREGA commands belong in the cloud at all.
