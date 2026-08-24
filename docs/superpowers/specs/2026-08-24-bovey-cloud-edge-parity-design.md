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

---

## 8. Rulings (independent review, 2026-08-24)

All five decisions were reviewed against both repos. **Three recommendations were
overturned**, one on safety grounds.

| # | Recommended | **Ruled** | Why |
|---|---|---|---|
| C1 | (b) cloud-appropriate page | **(b), but thinner** | The support-request form has **no cloud backend** — no controller or endpoint exists in osi-server. Including it is new scope, not a port. Ship language + account link; theme only if the Bovey frontend genuinely has one |
| C2 | (a) read-only + `editable` flag | **(a), flag dropped** | The flag is a comforting story: schedule authoring needs edge compile/pushState machinery and a richer response than any cloud endpoint can return under D2/D4. `editable=true` would light up dialogs whose data model does not exist |
| C3 | (a) port 9 components | **(c) small cloud-native view** | A faithful port renders mostly empty states. Reuse `ValveGlyph`, `valveState` helpers and a schedule list inside a small cloud `ValveCard`. Code never ported cannot drift |
| C4 | remove legacy card controls | **DEFER — do not touch** | **The cloud already has valve writes.** `StregaValveCard` dispatches open/close plus six advanced STREGA commands today. Removing them is a capability regression sold as decluttering |
| C5 | rename the account | **REJECTED — unsafe** | Sync tokens are JWTs with the **username as subject**; the gateway holds a long-lived token issued for subject `admin`. Renaming breaks the gateway's sync auth and forces a re-link — an edge touch this spec forbids |

**D4 reversal (sync `valve_settings`): NO.** A column migration plus triggers,
contract, cloud table and applier on a live gateway in presentation week, to
upgrade a panel from credible to rich, inverts this spec's one correct instinct.

### Factual corrections to §2 and §4

1. §2(c) is **half wrong**. Module toggles are client-side localStorage display
   preferences, not gateway hardware; only the scheduler-off path writes edge
   state. The conclusion survives for a different reason: they toggle *edge
   dashboard* cards the cloud does not render.
2. §2(b) is **wrong**. The valve components import **zero** `ui-core` primitives.
   Vendoring is orthogonal to C3 entirely.
3. §5 lists the combined branch as work; it **already exists** —
   `feat/bovey-cloud-parity` @ `2173c5ca`. Verify and deploy, do not rebuild.
4. C2/C4 implicitly assumed the cloud has no valve write path. It does.

### Revised scope

**Cut:** C4 legacy-card removal, C5 rename, the settings support form, the
9-component port, all `editable`-flag machinery, D4 reversal.

**Keep, in this order:**

1. Deploy `feat/bovey-cloud-parity` as-is. Banks most of the demo value before
   any new code exists.
2. Read-only cloud `ValveController` — `/api/v1/valves`,
   `/api/v1/valves/{eui}/schedules` — shaped to the fields the cloud actually has.
3. Small cloud valve panel: glyph + reduced tile + schedule list, no dialogs.
4. Thin `/settings` — only if time remains.
5. Prove the gateway untouched.

**Minimum credible deliverable:** Bovey branding plus a valve panel showing name,
zone, open/closed and the live-synced schedule list, with the demonstrable moment
*"a schedule created on the gateway appears in the cloud"* — and the legacy card
still able to open a valve. No step 2–4 failure can strand the demo.
