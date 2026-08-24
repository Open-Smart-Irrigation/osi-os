# Valve advanced controls — consolidation onto one surface: design

**Status:** draft for review. The fundamental decisions in §4 are deliberately
left open; §5 onward is contingent on them.

**Tracks:** [osi-os#171](https://github.com/Open-Smart-Irrigation/osi-os/issues/171)
(reconcile the legacy `StregaValveCard` with the Valve control panel) — this spec
is what that issue asks for, extended with the six advanced commands its
checklist was missing.

**Related:** the Phase A design (`2026-08-19-valve-control-design.md`) §12 phasing;
[2026-08-23-valve-cloud-parity-phase-b-design.md](2026-08-23-valve-cloud-parity-phase-b-design.md)
is the other half of the current review package and is independent of this one.

---

## 1. What this is

The dashboard has **two** valve-control surfaces for the same solenoid:

- **Valve control panel** (`valves/ValveControlPanel.tsx`) — the module the
  farmer is steered to, built in Phase A.
- **`StregaValveCard`** (`farming/StregaValveCard.tsx`) — the older card,
  reachable inside the zone card and under Unassigned Devices.

Keeping both is a deliberate decision (#171). This spec is about ending it
safely, and it exists because the retirement plan as written would silently drop
functionality.

## 2. The gap that motivated this

`StregaValveCard` is the **only** component in the application that imports
`stregaAPI`. Six commands hang off it, none of which the Valve control panel
carries:

| Client (`services/api.ts`) | Endpoint | Encoder |
|---|---|---|
| `setUplinkInterval` :781 | `PUT /api/devices/:deveui/strega/interval` | `SET_INTERVAL`, FPort 11 |
| `setModel` :789 | `…/strega/model` | (edge state only) |
| `setTimedAction` :792 | `…/strega/timed-action` | `TIMED_ACTION`, FPort 2 |
| `setMagnetEnabled` :799 | `…/strega/magnet` | `SET_MAGNET_MODE`, FPort 22 |
| `setPartialOpening` :802 | `…/strega/partial-opening` | `SET_PARTIAL_OPENING`, FPort 27, `[0x31\|0x30, pct]` |
| `setFlushing` :808 | `…/strega/flushing` | `SET_FLUSHING`, FPort 28 |

All six are implemented end to end — REST route,
`put-strega-advanced-authorize-fn` authorisation, and encoders in
`cdbaa3891d40d7a1`. Partial opening and flushing are additionally gated on
`devices.strega_model = 'motorized'` (`StregaValveCard.tsx:258,548-550,622`).

Both of #171's stated options lose them: option 2 removes the card outright,
option 1 keeps only "identity and diagnostics" — and these are controls.

## 3. Two hard constraints, established by reading the code

**(a) Aperture is commanded but never observed.** Neither
`strega_gen1_decoder.js` nor `strega_gen2_decoder.js` reports a position,
percentage or aperture — greps for `percent|position|aperture|opening` return
nothing in both. `devices.current_state` is binary and `osi-valve-control` only
ever writes `'OPEN'`. There is no column anywhere storing a commanded or
observed percentage.

So a motorized valve held at 40% is **indistinguishable in the database** from
one fully open. Any UI showing aperture can only ever show *what we last asked
for*, never *what the valve is doing* — and it must say so. This is the same
honesty rule the missing-data convention already imposes elsewhere: do not
render a commanded value as if it were a reading.

**(b) There are two capability flags, in two tables, with two owners.**

| Flag | Table | Values | Set by |
|---|---|---|---|
| `strega_model` | `devices` | STANDARD / MOTORIZED | legacy card (`setModel`) |
| `strega_generation` | `valve_settings` | GEN1 / GEN2 | Valve settings dialog |

They answer overlapping questions ("what can this valve do?") and nothing keeps
them consistent. Generation selects the *scheduler encoding*; model gates
*partial opening*. A GEN2 motorized valve is a legitimate combination, so they
are not redundant — but the split is not documented anywhere and a farmer meets
both in different dialogs.

## 4. Fundamental decisions — for independent review

### E1 — Where do advanced controls live?

**Choice:** (i) fold all six into the Valve control panel's settings dialog;
(ii) a separate "Advanced / service" surface, reachable from the valve but not
in the daily path; (iii) keep them on a reduced `StregaValveCard` that becomes
the service view while the panel owns daily operation.

**Evidence:** these are commissioning and maintenance actions — uplink interval,
magnet mode, anti-sediment flushing — not things a farmer touches weekly.
Putting them one tap from OPEN invites mistakes on a device that moves water.
Against that, (iii) perpetuates exactly the two-surface confusion #171 exists to
end.

**Recommendation: (ii).** One surface owns daily operation; a clearly separate,
clearly labelled service view owns the rest. That satisfies #171 (the daily
surface is unambiguous) without deleting capability.

**If wrong:** either advanced controls become too easy to hit, or a technician
has to hunt for them in the field.

### E2 — Do we persist commanded aperture, and how is it labelled?

Given §3(a), the options are: (a) do not persist — fire-and-forget, and the UI
shows no aperture at all; (b) persist the **commanded** value with explicit
"commanded, not confirmed" framing; (c) persist and attempt read-back, which
requires vendor support that does not exist today.

**Recommendation: (b) as an EVENT, not as state** — revised after E4 was
answered. Since the resting position is always 100% and the action is one-shot,
a `valve_settings.current_aperture` column would model a state that does not
exist and would be wrong the moment the next scheduled window ran. Record the
commanded action with its percentage and timestamp instead, and label it as an
action that happened ("40% partial opening sent 14:02"), not a position the
valve is holding.

**Open question for the reviewer:** where does that event belong — the existing
`osi-command-ledger`, a `valve_actuation_expectations` row (which already models
commanded-vs-observed and is where a percentage would naturally hang), or
nowhere at all, on the grounds that a one-shot service action with no read-back
may not be worth persisting? Option (a) — persist nothing — is more defensible
under E4's answer than it was before it.

**If wrong:** we either ship a control with no feedback at all, or build
reconciliation for a value the hardware will never confirm.

### E3 — Reconcile the two capability flags, or document the split?

**Choice:** merge into one capability concept on `valve_settings`; or keep both
and document precisely which governs what.

Note `strega_model` lives on `devices` while `strega_generation` lives on
`valve_settings` — merging means a data migration and a decision about which
table owns valve capability. Also note Phase B (D4) currently proposes
`valve_settings` stays **edge-only**, so anything moved there does not reach the
cloud. **These two decisions interact and should be ruled on together.**

**Recommendation: document the split now, merge later** — the split is real
(generation = encoding, model = mechanics), and merging is a migration that
should not ride along with a GUI consolidation.

### E4 — What aperture does a *scheduled* open use? — **RESOLVED, not open**

**Answered by the operator, 2026-08-24: `SET_PARTIAL_OPENING` is a ONE-TIME
action. The default opening is always 100%.**

So a scheduled `OPEN_FOR_DURATION` always runs fully open, and a 40% flush does
not leak into any later window. The risk that made this a blocker — a farmer
setting 40% once and silently under-irrigating every subsequent scheduled run —
does not exist. **Partial opening is safe to ship alongside the scheduler**, and
this decision needs no review.

**But the answer reshapes E2, which the reviewer must still rule on.** If the
action is one-shot and the resting position is always 100%, then "what aperture
is this valve at?" has no persistent answer to store: between actions it is
always 100% by definition. Persisting a *current aperture* field would therefore
model something that does not exist, and would go stale the moment the next
scheduled window runs.

What may still be worth recording is the **event** — "a 40% partial opening was
commanded at 14:02" — which is history, not state. Note the repo already has a
command ledger (`osi-command-ledger`) and `valve_actuation_expectations` for
exactly this commanded-action shape. E2's framing below predates this answer and
should be read through it.

### E5 — The five items #171 already lists

Delete, device EUI, "never seen" disclosure, pending-state honesty, and a
confirmation step on one-tap open. These are not in question — they are the
original acceptance criteria and this spec inherits them unchanged.

## 5. Scope under the recommended answers

**In:** a service view carrying all six commands; commanded-aperture persistence
with honest labelling; the five #171 items on the daily surface; documentation
of the capability-flag split.

**Out:** merging `strega_model` into `valve_settings` (E3, later); read-back of
actual position (needs vendor support, and is moot for a one-shot action);
any persistent "current aperture" field (E4's answer rules it out).

## 6. Verification

- Every one of the six commands reachable from the surviving surface, each
  producing the correct FPort (11, 2, 22, 27, 28) — assert the encoder output,
  not just that the request was sent.
- Partial opening and flushing remain gated on the motorized model, and the gate
  is discoverable (the current copy — "Set the valve model to motorized to
  unlock…" — is good and should survive).
- A commanded aperture renders as commanded, never as an observation.
- The legacy card's control surface is gone from the daily path, and no valve
  appears twice with contradictory state (the original #171 symptom).
- Existing suites stay green; the STREGA advanced authorisation path keeps its
  ownership checks.

## 7. Open items

- Phase A's spec §13 still carries an open question about SV2 scheduler
  read-back over LoRaWAN. E4 is answered, so that one travels to the vendor
  alone.
- Whether the T-Valve and UC512 (see `project_upcoming_valve_devices`) share
  this surface or need their own. The T-Valve is genuinely positional, so E2's
  answer will be load-bearing for it in a way it is not for STREGA.
