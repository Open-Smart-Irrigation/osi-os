# Journal Edge/Cloud Parity and Fast Capture

**Date:** 2026-09-06  
**Status:** Approved in conversation; revision under independent UX/farmer re-review
**Scope:** `osi-os` edge Journal, `osi-server` cloud Journal, and the paired gateway-backed API behavior  
**Supersedes:** cloud capture deviations that deliberately pinned `full_record` and omitted the edge capture workflow  
**Builds on:** [Field Journal design](2026-07-12-field-journal-design.md) and [Field Journal UX addendum](2026-07-12-field-journal-ux-addendum.md)

## 1. Outcome

The Journal must feel like one product on the gateway and on AgroLink. A user who
knows either surface must be able to use the other without learning a different
navigation model, capture sequence, vocabulary, or validation policy.

The most common task is recording an operation that just happened. On an already
configured desktop or phone, a normal quick entry must require only:

1. choosing one or more plots, or explicitly choosing **Farm-wide** for an
   activity allowed at farm level;
2. choosing an activity/operation;
3. accepting the prefilled occurrence time; and
4. entering only the operation-specific fact without which the record would be
   ambiguous or unusable.

Cloud-only workspaces, attachments, and conflict resolution remain cloud
extensions. They must not replace or fork the shared gateway-backed Journal flow.
The removed Status selector and Export research package control stay absent on
both surfaces. CSV and JSON export remain available.

This specification supersedes the parent design's UI status-filter requirement in
§6.4 and the parent UX addendum's implication that every final entry must contain
all facts immediately. It does not remove the parent design's lossless research
package endpoint: `/export.package` remains an authenticated API/automation
surface, but it has no GUI button. CSV and JSON are convenient UI exports, not a
claim that CSV replaces the lossless package.

## 2. Verified problems

### 2.1 Cloud is not a port of the edge capture experience

The edge uses `JournalCaptureFlow`: plot groups and station grids, multi-plot
selection, activity shortlists, crop-cycle handling, carry-forward, duplicate
review, drafts, tank mixes, batch finalization, and a confirmation strip.

Cloud uses a separate reduced `JournalCaptureModal`. It is single-plot,
single-entry, final-only, lacks the edge's guided safeguards, and displays plots
in one flat selector. That divergence is the main parity failure.

### 2.2 Cloud chooses the verbose template by default

Edge reads the user's detail preference and defaults to `farmer_quick`. Cloud's
`resolveCaptureDefinitions` explicitly selects `full_record` whenever supported.
Consequently cloud presents and validates more fields for the same plot and
operation than edge.

### 2.3 Machinery relevance depends on the plot layout

Operation-to-device restrictions exist in `open_field@9` and
`agroscope_open_field@1`. `lysimeter@3` and the current greenhouse layout contain
no such restrictions. A Lysimeter plot therefore offers the complete machinery
vocabulary even after an operation has been selected.

Operation/device compatibility is shared agronomic vocabulary. Physical
availability remains a layout or deployment fact. Effective machinery is therefore
the intersection of global operation compatibility, layout availability, and
active catalog choices; it is not one copied flat list.

### 2.4 Station and group scope is visual rather than functional

The edge scope rail can highlight a station or plot group, but entry queries and
exports accept only a single `plot_uuid`; station and group scopes deliberately
fall back to unfiltered results. Cloud does not expose station selection and caps
its reference preview at six resources. This made the first-created ST72 plots
visible while hiding ST12, despite all 84 plots being present.

### 2.5 Desktop capture wastes available space

Edge capture is a full-page flow constrained to `max-w-3xl`. Cloud capture is
inside a generic `max-w-lg` modal. Both force long forms into a narrow vertical
column on large screens.

## 3. Product decisions

### 3.1 Parity boundary

The following behavior is shared and must match:

- station, group, and plot navigation;
- station grid and range selection;
- entry list filters and CSV/JSON export scope;
- activity picker, shortlist ranking, search, and browse fallback;
- plot-first capture, multi-plot batch capture, and confirmation;
- detail preference and template resolution;
- field visibility, requiredness, dependency filtering, units, and labels;
- carry-forward, repeat-treatment confirmation, duplicate handling, drafts, and
  crop-cycle assistance where the backing authority supports them;
- loading, empty, unavailable, save, retry, and partial-failure presentation;
- responsive layout, typography, spacing, colors, keyboard behavior, and focus
  restoration.

The following remain cloud-only extensions:

- cloud-primary workspace selection;
- attachment upload and transfer state;
- conflict resolution.

The extensions appear beside the shared workspace and reuse its tokens. They do
not change the shared capture sequence.

### 3.2 Required-field policy

`farmer_quick` is the default on edge and cloud. Its normal final entry requires an
allowed scope, activity/operation, and occurrence time. The scope is one or more
plots, except `equipment_maintenance` and `general_observation`, which also permit
an explicit **Farm-wide** selection. Plot-dependent activities fail closed when no
plot is selected. The time defaults to now. Plot entries resolve layout from plot
settings. Farm-wide entries resolve only to the seeded `farm_wide@1` layout, which
supports `equipment_maintenance` and `general_observation`, allows Quick and Full
templates, and produces no zone, season, plot, or sensor-context snapshot.

The following operation facts remain blocking because omitting them makes the
record unusable:

| Operation family | Additional facts required for **Final** | Explicit missing status allowed? |
|---|---|---|
| Sowing/planting | Crop; one of applicable seed mass/count when the selected operation records an application quantity | Quantity may be `not_observed`; crop may not |
| Fertilizer or plant-protection application | Product or explicit product name; one applicable dose/quantity | Dose may be `not_observed`; product may not |
| Irrigation/fertigation | One applicable water amount; fertigation also follows the product rule | Water amount may be `not_observed`; product follows the application rule |
| Harvest | Crop; one applicable yield value | Yield may be `not_observed`; crop may not |
| General observation | Note or at least one structured observed value | No: an entirely empty observation is not final |
| Equipment maintenance | Equipment/device or note describing the work | No: an entirely empty maintenance record is not final |
| Other operations | No additional blocking fact | Not applicable |

When a required numeric fact is unknown, the user can choose **Not observed** and
finalize without inventing a value. When a required identity such as crop or
product is not yet known, **Save draft / Finish later** performs a durable draft
save and returns the entry to the **Drafts / Needs completion** tray. The interface
never converts an incomplete record to Final merely to shorten the flow.

Machinery/device, operator, treated area, weather, growth stage, end time, method,
and note are optional except for the explicit maintenance alternative above or a
future named compliance profile. A normal `full_record` entry uses the same
blocking policy; it reveals more fields but does not manufacture stricter
compliance rules. Useful missing details appear as non-blocking review suggestions.

This table is explanatory. The normative matrix in Appendix A supersedes the parent
design §4.4 `full_record` requiredness matrix where the two disagree. Total
quantities do not require a denominator; area-, plant-, or time-based rates require
the denominator implied by their chosen unit unless it is already fixed by the
typed quantity kind.

Required-any families are presented as one task, such as “Enter a dose,” rather
than marking every alternative field as independently required. Catalog generation,
client validation, edge finalization, and cloud-primary validation consume the same
matrix or byte-identical generated fixtures.

### 3.3 Progressive disclosure

After operation selection, the open form contains only:

- the selected plot scope and operation summary;
- the prefilled occurrence time;
- blocking operation-specific fields; and
- fields already populated by a safe carry-forward or plot default.

All remaining fields live under **More details**, grouped in this order: product
and amount, execution, conditions, crop/research context, then notes. A user can
save without opening it. Required controls can never be placed in the collapsed
group. Populated optional groups collapse to a one-line summary rather than
expanding the Quick form by default.

### 3.4 Machinery picker

The machinery/device picker shows the intersection:

`global operation-compatible devices ∩ layout-available devices ∩ active choices`.

The global relation has one generated source. Each layout carries an explicit
`available_device_codes` set or `availability_mode: all_compatible`. Absence of both
is an invalid active capture layout and blocks new capture; it never broadens the
picker. Because the repository has no authoritative AgroLink facility-equipment
inventory, the initial Lysimeter revision explicitly declares
`availability_mode: all_compatible`; the operation relation still narrows the
visible picker. Facility-specific narrowing is deferred until a maintained
equipment profile exists rather than guessed in seed data. Within the effective
set the picker orders choices as:

1. choices used on every selected plot, most recent first;
2. choices used on the greatest number of selected plots, then most recent;
3. choices most recently used in applied entries on the gateway/workspace;
4. remaining compatible choices alphabetically in the active locale.

A search field searches only the compatible set. If historic data references a
choice that is no longer compatible or active, correction/review screens retain
that value visibly but require an explicit change before substituting another.
No silent remapping occurs. An empty effective set explains that no machinery is
configured for that operation/layout and permits saving because machinery is
optional. Recency uses applied, non-voided entries from the previous 180 days;
ties resolve by latest occurrence and then stable choice code.

### 3.5 Desktop and mobile capture

Capture layout follows available content width through container queries rather
than a viewport-only `lg` breakpoint:

- below 1100px: sequential Where → Activity → Details → Review;
- 1100–1399px: two panes, with Where and Activity/details in the main pane and a
  320px sticky Review pane;
- 1400px and above: three panes, with Where at 280–340px, Activity/details at a
  minimum 520px, and Review at 320px.

The near-full-screen workspace is bounded by the existing application maximum width
(`1600px`) and viewport height:

```text
+----------------------+--------------------------------+----------------------+
| Where                | Activity and details           | Review               |
| station/group/plots  | shortlist/search + fields      | selected scope       |
| 280–340 px           | flexible main column           | sticky save, 320 px  |
+----------------------+--------------------------------+----------------------+
```

The right review column remains visible while the main column scrolls. Save is
reachable without scrolling to the bottom. Editing a review token moves focus to
the corresponding field. The workspace uses the Journal/Data gray page background,
gray structural panels, and white fields/cards.

On smaller screens the existing sequential flow remains: Where → Activity →
Details → Review. Touch targets remain at least 44px; primary navigation targets
remain 56px where already established.

Attachments are cloud-primary-only until a separate gateway attachment contract
exists. In cloud-primary capture they appear in a collapsible section below shared
details and surface upload state in Review. Gateway-backed capture hides the
section and makes no media-attachment claim. Conflicts are resolved outside an
active new-entry flow.

Capture uses route semantics on both surfaces, not the generic narrow modal. The
invoking element and return location are recorded before navigation. Cancel,
Escape, and successful completion restore focus to the actual invoking control;
if it no longer exists, focus moves to the Journal heading.

## 4. Architecture

### 4.1 Shared behavior with authority adapters

The edge implementation remains the behavioral reference. Cloud ports the shared
pure journal modules and capture components using the repository's existing
copy-adapt/provenance convention. Shared components do not call transport APIs
directly. They depend on a typed `JournalCaptureAdapter` that provides:

- list/revalidate plots and plot groups;
- create/update plot resources when allowed;
- load/save/discard drafts;
- create one entry or an atomic multi-plot batch;
- duplicate lookup and existing-entry navigation;
- crop-cycle lookup/correction capabilities;
- recent-operation and carry-forward inputs;
- capability flags for unavailable actions.

Adapters are:

1. **Edge local:** direct authenticated edge Journal endpoints; edge remains
   canonical.
2. **Cloud gateway-backed:** reads the cloud mirror, sends edge-owned mutations
   through the existing desired-state/command path, and presents pending state
   honestly.
3. **Cloud-primary workspace:** writes journal mutations directly to the workspace;
   plot snapshots are read-only; attachments are enabled.

Unsupported capabilities are explicit. A component hides a creation action only
when the adapter reports it unavailable and explains the authority boundary when
that absence could surprise the user.

The shared workspace always exposes two status-specific trays rather than a
general Status selector:

- **Drafts / Needs completion** contains durable drafts the user can resume or
  discard;
- **Waiting for farm** contains gateway-backed commands that are pending, rejected,
  or unresolved after timeout.

Both trays have keyboard-reachable controls and visible counts. They are not table
filters and do not imply that pending commands are canonical journal entries.

### 4.2 Template preference

Both clients use one shared template-resolution function. It chooses the user's
detail preference when supported and otherwise chooses the least verbose supported
template in the established order:

`farmer_quick` → `full_record` → `research_observation`.

Both default to `farmer_quick`. Cloud must not special-case `full_record`. The
preference uses the same allowed values and labels. A legacy
`research_observation` preference normalizes to `full_record` as edge already does.

### 4.3 Catalog dependency parity

A new additive catalog revision separates global operation/device compatibility
from per-layout device availability. Existing catalog rows remain immutable.

A generator/helper owns the canonical compatibility relation and builds each
layout's effective dependency rows from it plus `available_device_codes` or the
explicit `availability_mode: all_compatible`. New layout definition JSON is
produced rather than manually retyping choices. A static verifier fails when an
active capture layout omits both declarations, omits an operation, references an
unknown choice, or emits a dependency outside the computed intersection. It
includes positive, negative, empty-set, and retained-historical-choice fixtures.
Edge seed copies and both Pi profiles remain byte-identical. Cloud consumes the
catalog delivered for the gateway/workspace; it does not maintain a second
hand-authored compatibility list.

Server-side entry validation uses the same selected layout dependency rules as the
clients. A stale client cannot submit an incompatible operation/device pair without
an explicit validation error.

### 4.4 Scope filters

Both gateway-backed entry APIs accept mutually exclusive optional scope filters:

- `plot_uuid`;
- `station_code`; or
- `group_uuid`.

The authenticated owner/gateway scope is always applied first. `station_code`
matches active, non-deleted plots in that station. `group_uuid` matches active
membership in the selected group; resolved groups remain selectable only from the
resolved-groups section. Pagination happens after the scope predicate.

`station_code` is Unicode-NFKC normalized, trimmed, case-sensitive after
normalization, and limited to 240 UTF-8 bytes. `group_uuid` must be a canonical
UUID. Stable external errors are `conflicting_scope_filters` (400) and
`scope_not_found` (404). Unknown and inaccessible scope return the same status,
code, and message; a PII-safe `scope_forbidden` reason may exist only in internal
diagnostics.

A group filter always means **entries for the group's current member plots at the
time of this request**. It does not claim that the entries were authored through
the group. The UI and export manifest use that exact wording. Resolved groups have
frozen membership; changing membership requires explicit unresolve, edit, and
resolve actions. Historical cohort provenance is not inferred because entries do
not snapshot group membership.

CSV and JSON exports use the identical normalized filter object and therefore
export exactly the rows represented by the table. Unknown or inaccessible scopes
return 404, not an unfiltered result. Conflicting scope parameters return 400.

Cloud-primary workspaces expose an equivalent read endpoint over
`journal_plot_snapshots`, including station code and layout settings. This supplies
the shared plot picker without granting cloud mutation authority over plots.

### 4.5 Gateway-backed batch command and capability

Gateway-backed cloud batching is unavailable unless the gateway advertises
`journal_entry_batch_v1`. The capability is enabled only after the following
versioned command contract and edge applier ship:

- command type: `UPSERT_JOURNAL_ENTRY_BATCH`;
- `contract_version: 1`, one canonical `batch_uuid`, and 1–100 members;
- `shared` contains the single activity, template/layout pins, occurrence,
  canonical values, and other fields common to every entry;
- each compact member contains only stable client-generated `entry_uuid`,
  `base_sync_version: 0`, and `plot_uuid`; the edge derives and validates zone,
  season, and context independently per plot;
- the serialized command is limited to 256 KiB and existing single-entry limits
  still apply to shared strings/values; a golden 100-member maximum fixture and the
  AgroLink 84-member fixture must fit below the cap;
- one effect key `journal_entry_batch:{batch_uuid}:0` and one separately stored
  payload hash over shared fields plus canonical member order by
  `(plot_uuid, entry_uuid)`; same-key/different-hash replay is permanently rejected;
- the edge validates every member before writing, then commits all entries, values,
  outbox aggregates, terminal ledger result, and ACK outbox row in one transaction;
- replay returns the exact stored receipt, including each member UUID/version and
  duplicate-candidate result, without writing again;
- an edge without the capability returns durable
  `REJECTED_PERMANENT / unsupported_command_type`.

The command, capability, and effect key are added together to the edge-owned sync
schemas, `effect-keys.md`, golden capability metadata, cloud vendor copies, and
command-path fixtures.

Cloud deploys contract acceptance and pending-state storage first. Edge support and
capability advertisement deploy second. The cloud UI enables gateway-backed
multi-plot capture only after observing the capability. Edge-local and
cloud-primary batch paths retain their native atomic transactions.

### 4.6 Reference data

The cloud reference panel removes the six-resource truncation as a discovery
mechanism. Its compact summary may show counts and a few examples, but **View all**
opens the shared station/group/plot browser. All 84 AgroLink plots must be reachable
from the GUI, with ST72 and ST12 represented as separate station sections.

## 5. Data and save flow

1. Opening capture loads the catalog, plot hierarchy, user preference, shortlist,
   and draft index in parallel.
2. The shell renders immediately with skeletons in unresolved regions; catalog or
   plot failure does not blank the entire Journal workspace.
3. Selecting a station/group chooses a scope. Selecting plots derives their common
   layout; mixed-layout batch selection is rejected before activity entry. For a
   multi-plot selection, a default or carry-forward value is applied only when its
   value, catalog semantics, crop-cycle context, and validity are identical for
   every selected plot. Provenance may be either the same source entry or one source
   entry per plot where all sources share one prior `batch_uuid` and the carried
   value is identical. Otherwise the field starts empty and a differences summary
   offers **Split selection**, **Remove plots**, or **Continue without prefill**.
4. Activity selection resolves the leaf operation and compatible machinery.
5. The form derives blocking and optional fields from the active catalog definition.
6. Autosave persists a draft through the adapter after a 750ms idle interval and on
   step transitions. Edge and cloud-primary drafts are durable canonical drafts.
   Gateway-backed cloud drafts are cloud-durable working copies only: they never
   queue an edge command, never appear in the edge journal, and are discarded only
   from cloud. **Save draft / Finish later** confirms that cloud working-copy save.
   Finalization sends the existing single-final command or the capability-gated
   batch command. The UI distinguishes browser working copy, cloud-durable working
   copy, canonical edge/cloud-primary draft, and volatile-only state.
7. Review summarizes plot scope, operation, time, and entered facts. Optional
   omissions are suggestions, not errors.
8. A multi-plot review summarizes compactly, for example
   **84 plots — ST72: 72, ST12: 12**, with an expandable virtualized plot list.
   Duplicate review is one table with per-plot **Exclude**, **Open existing**, and
   **Save separately** choices plus safe apply-to-all actions. It never opens 84
   sequential dialogs.
9. Save creates a final entry or atomic batch. Protocol state maps to presentation
   state exactly:
   - queued, leased, or `FAILED_RETRYABLE` ACK → `PENDING` in **Waiting for farm**;
   - `REJECTED_PERMANENT` → terminal **Rejected**, retaining payload and correction/
     discard actions;
   - `CONFLICT` → terminal **Needs conflict resolution**, retaining both versions;
   - `EXPIRED` → terminal **Expired**, offering a fresh revalidation/resubmit action;
   - transport ambiguity → `UNKNOWN_AFTER_TIMEOUT`, with receipt lookup required
     before retry;
   - edge `APPLIED` before mirror convergence → **Applied on farm, syncing**;
   - matching mirror entry version and payload hash observed → canonical `APPLIED`.
10. Only canonical `APPLIED` updates table/export/recents and removes the working
    copy. Delayed, reordered, or missing ACK/outbox events cannot materialize an
    optimistic canonical entry. After close, focus returns to the actual invoking
    control, with the Journal heading as fallback.

## 6. Error handling

- Catalog incompatibility blocks capture but leaves close/retry controls available.
- Missing or stale plot snapshots show an explicit unavailable state; they never
  fall back to farm-wide or unfiltered data.
- Authorization loss, plot deactivation/deletion, layout-version change, or catalog
  refresh during capture preserves the working draft and typed fields, identifies
  the invalid scope/definition, blocks finalization, and offers **Reselect**,
  **Copy into a new draft**, or **Discard**. It never silently resets to All entries.
- Batch creation is all-or-none. A transport timeout triggers an idempotent receipt
  lookup before retry so duplicates are not created.
- Invalid dependency submissions identify the changed operation/machinery pair and
  preserve the rest of the draft.
- Pending cloud commands, rejected edge commands, confirmed saves, and unknown
  timeout outcomes use the receipt state machine in §5 and distinct language.
- Attachment failures do not erase a successfully saved cloud-primary entry;
  retryable files remain in the transfer queue.

## 7. Performance and accessibility

- Opening the Journal does not wait for the full capture bundle. Capture-only code
  is lazy-loaded when requested.
- Plot hierarchy and catalog requests are cached by version and invalidated after a
  relevant mutation or sync update.
- Station sections virtualize or collapse their plot grids where needed; a 72-plot
  station must not create an unwieldy select menu.
- Search and field derivation remain local pure operations after catalog load.
- A failed shortlist, recents, draft index, or plot-group request gets its own retry
  state. Failure is never rendered as an empty list. Core manual activity browsing
  remains available when recents fail.
- Plot and activity card grids use one Tab stop per grid and arrow-key/roving-tab
  navigation. The station range field precedes the plot grid in tab order.
- Validation produces an error summary linked to controls and focuses the first
  invalid control. A review token targeting a collapsed optional field opens its
  group before moving focus.
- `aria-live` announces autosave state, range-selection counts, pending/applied/
  rejected receipts, and retry outcomes without repeatedly announcing unchanged
  content.
- Escape uses the same guarded cancel path as the visible Close control. Unsaved or
  volatile changes require confirmation; durable drafts may close directly.
- WCAG 2.2 AA contrast, focus appearance, target size, and reflow are acceptance
  requirements. Automated accessibility checks cover the capture route and trays.
- Geometry fixtures at content widths 1024, 1280, 1440, and 1600px, plus 200% zoom,
  must show no horizontal overflow, clipped fields, sticky overlap, or unreachable
  Save/Close. The two- and three-pane minimum widths in §3.5 are enforced.
- User-facing strings use the Journal i18n namespace in every shipped locale.

### 7.1 Fast-entry benchmarks

Benchmarks start when the user activates **Log activity** and end when the applied
or pending receipt is visibly announced. Catalog, plot hierarchy, and recents are
warmed; occurrence time needs no activation. “Primary activation” means tap, click,
Enter/Space selection, or field confirmation, excluding scrolling.

| Fixture | Input conditions | Desktop ceiling | Phone ceiling | Human target |
|---|---|---:|---:|---:|
| Zero-extra-fact operation | last plot and operation offered; no typing | 5 activations | 7 activations | p75 ≤ 10s |
| Repeat fertilizer/treatment | last plot offered; valid recent product/dose card accepted; no typing | 7 activations | 9 activations | p75 ≤ 10s |
| Routine station batch | station offered; range/all selection; common operation and identical safe prefill | 8 activations | 10 activations | p75 ≤ 15s |

Component tests pin the activation paths and confirm the prefilled time is not
focused or changed. A pilot usability pass runs five attempts per fixture with at
least four representative users (two field workers and two research technicians);
the p75 target determines whether the under-ten-second product outcome may be
claimed. Technical deployment and enablement require the deterministic activation
ceilings and live functional checks; human timing is a reported product KPI, not a
rollback trigger. A valid recent product/dose appears as one consequential
carry-forward card and requires one confirming activation, preserving the parent
AGR-7 safety rule.

## 8. Delivery slices

### Slice A — Scope correctness and discovery

- add station/group filters to edge and cloud entry queries and CSV/JSON exports;
- add cloud workspace plot-snapshot listing;
- port the station/group/plot browser to cloud;
- remove the six-item discovery cap;
- prove ST72 and ST12 selection and export behavior.
- add **Drafts / Needs completion** and **Waiting for farm** tray navigation without
  reintroducing the general Status selector.

### Slice B — Shared fast capture

- define the adapter interface and port the edge capture components to cloud;
- make template preference resolution identical and default cloud to Quick;
- implement the responsive full-screen desktop shell on both;
- retain the mobile stepped flow and cloud-only attachment extension;
- add drafts, multi-plot batch, confirmation, carry-forward, duplicate handling,
  and crop-cycle capability behavior through adapters.
- add the gateway batch command consumer/storage first, then the edge atomic applier
  and `journal_entry_batch_v1` capability before enabling cloud batch capture.

### Slice C — Catalog and validation correction

- publish additive template/layout catalog revisions implementing the code-level
  balanced requiredness matrix;
- seed `farm_wide@1` with only maintenance and general-observation activities and
  no context-producing fields;
- generate global operation/device compatibility and explicit per-layout
  availability, including `all_compatible` for the initial Lysimeter revision;
- enforce compatible pairs on edge and cloud-backed validation paths;
- add catalog generation/parity verification.

### Slice D — Drift prevention and polish

- extend cross-repository provenance tests to all shared pure modules and shared
  capture components;
- add semantic parity fixtures for filters, field derivation, and capture receipts;
- run visual desktop/mobile checks on edge and AgroLink;
- update durable documentation where implementation changes established behavior.

Slices may be separate commits, but they deploy together to AgroLink so users do not
receive a partially divergent workflow. Any schema/API compatibility addition is
deployed consumer-first before a producer depends on it.

## 9. Verification contract

### 9.1 Unit and component tests

- edge and cloud resolve the same layout/template for every preference combination;
- Quick is the default in both clients;
- balanced requiredness for every activity/operation family;
- farm-wide maintenance and general observations work while plot-dependent
  activities fail closed, and farm-wide entries contain no plot/zone/season/context;
- `not_observed` satisfies only the explicitly allowed numeric families;
- empty observations and maintenance records cannot become Final;
- machinery choices equal the global/layout/active intersection on open-field,
  greenhouse, and Lysimeter layouts, including positive, negative, empty-set, and
  retained-historical-value cases;
- required controls never appear under a closed optional disclosure;
- station/group/plot filters constrain page one, later pages, CSV, and JSON equally;
- ST72 shows 72 plots and ST12 shows 12; both can be selected independently;
- desktop fixtures obey the one-/two-/three-pane geometry contract with a sticky
  save action and no overflow at 200% zoom;
- mobile retains the ordered four-step flow;
- the three fast-entry fixture paths stay within their activation ceilings;
- multi-plot prefills apply only when value and provenance agree across every plot;
- batch review handles mixed crop cycles, conflicting carry-forward, 0/1/84
  duplicates, and all-84 selection without sequential dialogs;
- cloud authority adapters neither mutate edge-owned plots in cloud-primary mode nor
  report a pending gateway command as a confirmed save;
- `APPLIED`, `PENDING`, `REJECTED`, and `UNKNOWN_AFTER_TIMEOUT` receipts affect only
  their specified views and ranking;
- gateway-backed drafts stay cloud-only and never emit per-keystroke or draft edge
  commands;
- cloud-primary attachments remain available and recoverable, while gateway-backed
  capture contains no attachment section;
- automated accessibility checks cover grid navigation, first-error focus,
  disclosure opening, live announcements, and invoking-control focus restoration.

### 9.2 Backend and contract tests

- authorization is applied before scope resolution;
- inaccessible/unknown station and group filters fail closed;
- pagination and export share filter normalization;
- group filters are explicitly current-membership views and resolved membership is
  frozen;
- the versioned gateway batch command is capability-gated, atomic, idempotent, and
  returns exact replay receipts, while both 84- and 100-member fixtures remain below
  the 256 KiB cap;
- catalog dependency and requiredness validation rejects stale incompatible input;
- catalog seeds, generated fragments, bundled databases, and profile copies pass
  parity checks;
- cloud plot-snapshot listing is workspace-scoped and read-only;
- authorization loss, plot deactivation, layout change, and catalog refresh preserve
  drafts and block stale finalization;
- delayed, reordered, and missing ACK/outbox sequences cannot materialize an
  optimistic canonical entry.

### 9.3 Required repository gates

Edge minimum:

```bash
node scripts/test-journal-schema.js
node scripts/verify-sync-contract.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-op-parity.js
node scripts/test-journal-command-path.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
node scripts/verify-db-schema-consistency.js
cd web/react-gui
npm run test:unit
npm run build
```

Cloud minimum:

```bash
cd frontend
npm run test:unit
npm run build
cd ../backend
./gradlew test
```

Targeted tests run first during TDD. `git diff --check` and the repo's TypeScript
overlays are mandatory in both repositories.

## Appendix A — Normative final-entry requirement matrix

`scripts/generate-journal-catalog.js` owns and exports
`FINAL_REQUIREMENT_MATRIX_V11`. The generator emits the matrix into additive
template rows and a JSON fixture consumed byte-for-byte by edge validator tests and
vendored cloud tests. Activity rules apply when no listed leaf override is selected;
leaf rules replace, rather than merge with, their activity rule.

Every Final entry first requires `activity_code`, `occurred_start`, and a permitted
scope. `equipment_maintenance` and `general_observation` permit either a plot or the
`farm_wide@1` layout; every other activity requires at least one plot.

Notation: `A | B` is one `required_any` family. `missing` names statuses that may
satisfy that family through exactly one status-only value row.

| Activity code | Required | Required-any | Allowed missing |
|---|---|---|---|
| `irrigation` | — | `attr.irrigation_depth | attr.irrigation_volume_area | attr.per_plant_volume` | `not_observed` for that family |
| `fertilization` | — | `attr.product_uuid | attr.product`; `attr.amount_mass_area_product | attr.amount_volume_area_product | attr.amount_nutrient_rate` | `not_observed` for amount family only |
| `fertigation` | — | product family; fertilizer amount family; irrigation amount family | `not_observed` for both amount families |
| `plant_protection_application` | — | `attr.product_uuid | attr.product`; `attr.amount_mass_area_product | attr.amount_volume_area_product | attr.amount_biological_count_area` | `not_observed` for amount family only |
| `weed_control_nonchemical` | — | — | — |
| `seeding` | `attr.crop` | `attr.amount_mass_area_product | attr.amount_count_area` | `not_observed` for amount family |
| `planting_transplanting` | `attr.crop` | `attr.amount_count_area` | `not_observed` for amount family |
| `pruning` | — | — | — |
| `crop_care` | — | — | — |
| `tillage_soil_work` | — | — | — |
| `mowing` | — | — | — |
| `harvest` | `attr.crop` | `attr.harvest_yield_area` | `not_observed` for yield family |
| `sampling` | — | — | — |
| `general_observation` | — | `note | attr.observation_text | attr.growth_stage_bbch` | none; at least one observed value/text |
| `pest_disease_observation` | — | `note | attr.observation_text | attr.target` | none; at least one observed value/text |
| `equipment_maintenance` | — | `attr.equipment | attr.agroscope.device | note` | none; at least one observed value/text |

The exact leaf replacements are:

| Leaf operation codes | Required | Required-any | Allowed missing |
|---|---|---|---|
| `primary_tillage`, `seedbed_preparation`, `stubble_cultivation`, `weed_mechanical`, `weed_other`, `cleaning_cut` (all under `agroscope.operation.*`) | — | — | — |
| `sowing_main_crop`, `sowing_cover_crop` | `attr.crop` | `attr.amount_mass_area_product | attr.amount_count_area` | `not_observed` for amount family |
| `organic_fertilization`, `mineral_fertilization`, `other_fertilization` | — | product family; fertilizer amount family | `not_observed` for amount family |
| `fungicide`, `insecticide`, `growth_regulator`, `weed_herbicide`, `total_herbicide` | — | product family; `attr.amount_mass_area_product | attr.amount_volume_area_product` | `not_observed` for amount family |
| `biocontrol` | — | product family; `attr.amount_biological_count_area | attr.amount_mass_area_product | attr.amount_volume_area_product` | `not_observed` for amount family |
| `pest_control` | — | product family; `attr.amount_mass_area_product | attr.amount_volume_area_product` | `not_observed` for amount family |
| `harvest_main_crop`, `harvest_cover_crop` | `attr.crop` | `attr.harvest_yield_area` | `not_observed` for yield family |
| `hay_removal`, `straw_removal` | — | `attr.harvest_yield_area` | `not_observed` for yield family |
| `watering` | — | irrigation amount family | `not_observed` for amount family |
| `sampling` | — | `note | attr.observation_text | attr.growth_stage_bbch` | none; at least one observed value/text |
| `note` | — | `note | attr.observation_text` | none; at least one observed value/text |

Here “product family,” “fertilizer amount family,” and “irrigation amount family”
mean the exact attribute lists in the activity table above. Machinery remains
optional for every leaf.

All quantity attributes in this matrix encode their denominator in the typed
attribute and allowed unit: `_area_` is area-based and `per_plant` is plant-based.
They therefore never make generic `attr.denominator` blocking. The UI offers only
units compatible with that typed denominator, and server validation rejects a
dimension mismatch. A later generic total/rate attribute must declare its exact
denominator dependency in this matrix before it can be used for Final.

For an allowed missing quantity, **Not observed** is a secondary action on the
required-any task, not one action per alternative field. Activating it selects the
first applicable quantity attribute in the matrix order, writes exactly one row
with `value_status: not_observed` and all value/unit columns null, collapses the
other alternatives, and displays “Not observed” in Review. **Enter value** removes
that status-only row and restores the alternatives. `not_observed` never satisfies
a product, crop, note, target, equipment, or observation family. Component tests
exercise the control and serialized payload in addition to pure validator tests.

## 10. Deployment and live acceptance

Only AgroLink is in scope. Never access or modify `osicloud.ch`, Bovey, or the
generic `osi-*` deployment.

Before deployment:

- both repositories are clean, committed, and pushed;
- independent verification is green;
- a timestamped AgroLink backup exists under `/home/rocky/backups/`;
- the current backend image has a rollback tag;
- the backend image is built locally for `linux/amd64` and transferred to
  `agro-link.ch` without compiling on the VPS.

Recreate only `agrolink-backend` using Compose project `agrolink` from
`/home/rocky/docker/agrolink/osi-server/docker`.

Live acceptance requires:

- `/actuator/health` returns `{"status":"UP"}`;
- backend startup, Flyway, API, and WebSocket logs have no new errors;
- gateway `0016C001F116EBF2` retains fresh REST and MQTT activity;
- private-window verification shows the new Journal assets;
- ST72 and ST12 are separately visible and selectable;
- selecting either station filters entries and CSV/JSON exports consistently;
- Lysimeter operations show only globally compatible, layout-available active
  machinery;
- a normal Quick entry can reach review without opening More details;
- desktop capture uses the available workspace and keeps Save visible;
- cloud-primary attachments and conflict controls remain available; gateway-backed
  capture shows no attachment section;
- pending gateway entries appear only in **Waiting for farm** until edge ACK;
- the three fast-entry fixtures meet their deterministic activation ceilings; the
  measured human p75 is reported separately and controls only the speed claim;
- Status and Export research package controls remain absent.

If any acceptance check fails, restore the preserved image to `dev-local`, recreate
only `agrolink-backend`, verify health, and report the evidence.

## 11. Non-goals

- A general package shared at runtime between the two repositories.
- Cloud ownership of gateway-backed plots.
- New compliance certification or legal retention claims.
- Automatic machinery choice when more than one compatible choice exists.
- Reintroducing the Status filter or Export research package control.
- Claiming group membership at query time is historical entry provenance.
- Gateway-backed attachments before a separate attachment contract exists.
- Deploying to any host other than `agro-link.ch`.
