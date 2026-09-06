# Journal Edge/Cloud Parity and Fast Capture

**Date:** 2026-09-06  
**Status:** Approved in conversation; pending independent UX/farmer review  
**Scope:** `osi-os` edge Journal, `osi-server` cloud Journal, and the paired gateway-backed API behavior  
**Supersedes:** cloud capture deviations that deliberately pinned `full_record` and omitted the edge capture workflow  
**Builds on:** [Field Journal design](2026-07-12-field-journal-design.md) and [Field Journal UX addendum](2026-07-12-field-journal-ux-addendum.md)

## 1. Outcome

The Journal must feel like one product on the gateway and on AgroLink. A user who
knows either surface must be able to use the other without learning a different
navigation model, capture sequence, vocabulary, or validation policy.

The most common task is recording an operation that just happened. On an already
configured desktop or phone, a normal quick entry must require only:

1. choosing one or more plots;
2. choosing an activity/operation;
3. accepting the prefilled occurrence time; and
4. entering only the operation-specific fact without which the record would be
   ambiguous or unusable.

Cloud-only workspaces, attachments, and conflict resolution remain cloud
extensions. They must not replace or fork the shared gateway-backed Journal flow.
The removed Status selector and Export research package control stay absent on
both surfaces. CSV and JSON export remain available.

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

The operation/device relationship is shared agronomic vocabulary, not a property
of the physical growing layout. Until the catalog format is normalized, every
general-purpose layout that exposes Agroscope operation/device choices must carry
the same canonical restriction fragment, with a verifier preventing drift.

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

`farmer_quick` is the default on edge and cloud. Its normal final entry requires
plot scope, activity/operation, and occurrence time. The time defaults to now and
the plot layout comes from plot settings.

The following operation facts remain blocking because omitting them makes the
record unusable:

| Operation family | Additional blocking facts |
|---|---|
| Sowing/planting | Crop; one applicable seed rate/count when the chosen operation records application quantity |
| Fertilizer or plant-protection application | Product or explicit product name; one applicable dose/quantity |
| Irrigation/fertigation | One applicable water amount; fertigation also follows the product rule |
| Harvest | Crop and yield |
| Other operations and observations | No additional blocking field |

Machinery/device, operator, treated area, weather, growth stage, end time, method,
and note are optional unless a future named compliance profile explicitly requires
them. A normal `full_record` entry uses the same blocking policy; it reveals more
fields but does not manufacture stricter compliance rules. Useful missing details
may be listed as non-blocking review suggestions.

Required-any families are presented as one task, such as “Enter a dose,” rather
than marking every alternative field as independently required.

### 3.3 Progressive disclosure

After operation selection, the open form contains only:

- the selected plot scope and operation summary;
- the prefilled occurrence time;
- blocking operation-specific fields; and
- fields already populated by a safe carry-forward or plot default.

All remaining fields live under **More details**, grouped by purpose rather than
as one catalog-ordered list. A user can save without opening it. Required controls
can never be placed in the collapsed group.

### 3.4 Machinery picker

The machinery/device picker shows only choices compatible with the selected
operation. Within that set it orders choices as:

1. most recently used for the selected plot;
2. most recently used on the gateway/workspace;
3. remaining compatible choices alphabetically in the active locale.

A search field searches only the compatible set. If historic data references a
choice that is no longer compatible or active, correction/review screens retain
that value visibly but require an explicit change before substituting another.
No silent remapping occurs.

### 3.5 Desktop and mobile capture

On desktop (`lg` and wider), capture is a near-full-screen workspace bounded by
the existing application maximum width (`1600px`) and viewport height:

```text
+----------------------+--------------------------------+----------------------+
| Where                | Activity and details           | Review               |
| station/group/plots  | shortlist/search + fields      | selected scope       |
| 280–360 px           | flexible main column           | sticky save, 320 px  |
+----------------------+--------------------------------+----------------------+
```

The right review column remains visible while the main column scrolls. Save is
reachable without scrolling to the bottom. Editing a review token moves focus to
the corresponding field. The workspace uses the Journal/Data gray page background,
gray structural panels, and white fields/cards.

On smaller screens the existing sequential flow remains: Where → Activity →
Details → Review. Touch targets remain at least 44px; primary navigation targets
remain 56px where already established.

Cloud attachments appear in a collapsible section below shared details and surface
their upload state in the review column. Conflicts are resolved outside an active
new-entry flow.

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

### 4.2 Template preference

Both clients use one shared template-resolution function. It chooses the user's
detail preference when supported and otherwise chooses the least verbose supported
template in the established order:

`farmer_quick` → `full_record` → `research_observation`.

Both default to `farmer_quick`. Cloud must not special-case `full_record`. The
preference uses the same allowed values and labels. A legacy
`research_observation` preference normalizes to `full_record` as edge already does.

### 4.3 Catalog dependency parity

A new additive catalog revision supplies the canonical operation-to-device choice
restrictions to every active general-purpose layout that exposes those choices,
including Lysimeter. Existing catalog rows remain immutable.

A generator/helper owns the canonical restriction fragment. New layout definition
JSON is produced from that fragment rather than manually retyping its choices. A
static verifier fails when a supporting layout omits an operation, adds an unknown
choice, or disagrees with the canonical fragment. Edge seed copies and both Pi
profiles remain byte-identical. Cloud consumes the catalog delivered for the
gateway/workspace; it does not maintain a second hand-authored compatibility list.

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

CSV and JSON exports use the identical normalized filter object and therefore
export exactly the rows represented by the table. Unknown or inaccessible scopes
return 404, not an unfiltered result. Conflicting scope parameters return 400.

Cloud-primary workspaces expose an equivalent read endpoint over
`journal_plot_snapshots`, including station code and layout settings. This supplies
the shared plot picker without granting cloud mutation authority over plots.

### 4.5 Reference data

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
   layout; mixed-layout batch selection is rejected before activity entry.
4. Activity selection resolves the leaf operation and compatible machinery.
5. The form derives blocking and optional fields from the active catalog definition.
6. Autosave persists a draft through the adapter. A volatile-only state is labelled
   honestly if persistence fails.
7. Review summarizes plot scope, operation, time, and entered facts. Optional
   omissions are suggestions, not errors.
8. Save creates a final entry or atomic batch. Gateway-backed cloud shows pending
   edge application where applicable; cloud-primary saves directly.
9. Success updates table, draft queue, and recent-choice ranking without a full page
   reload. Focus returns to **Log activity** after closing.

## 6. Error handling

- Catalog incompatibility blocks capture but leaves close/retry controls available.
- Missing or stale plot snapshots show an explicit unavailable state; they never
  fall back to farm-wide or unfiltered data.
- A scope becoming unauthorized during use returns to All entries and shows why.
- Batch creation is all-or-none. A transport timeout triggers an idempotent receipt
  lookup before retry so duplicates are not created.
- Invalid dependency submissions identify the changed operation/machinery pair and
  preserve the rest of the draft.
- Pending cloud commands, rejected edge commands, and confirmed saves use distinct
  states and language.
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
- Keyboard order follows Where → Activity/details → Review/save. Every disclosure,
  token, picker, and error is keyboard accessible with a visible focus state.
- Desktop columns collapse without horizontal overflow. At 200% zoom, save and
  close remain reachable.
- User-facing strings use the Journal i18n namespace in every shipped locale.

## 8. Delivery slices

### Slice A — Scope correctness and discovery

- add station/group filters to edge and cloud entry queries and CSV/JSON exports;
- add cloud workspace plot-snapshot listing;
- port the station/group/plot browser to cloud;
- remove the six-item discovery cap;
- prove ST72 and ST12 selection and export behavior.

### Slice B — Shared fast capture

- define the adapter interface and port the edge capture components to cloud;
- make template preference resolution identical and default cloud to Quick;
- implement the responsive full-screen desktop shell on both;
- retain the mobile stepped flow and cloud-only attachment extension;
- add drafts, multi-plot batch, confirmation, carry-forward, duplicate handling,
  and crop-cycle capability behavior through adapters.

### Slice C — Catalog and validation correction

- publish additive template/layout catalog revisions implementing the balanced
  required-field policy;
- add canonical operation/device dependencies to Lysimeter and other supporting
  layouts;
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
- machinery choices exactly match the selected operation on open-field,
  greenhouse, and Lysimeter layouts;
- required controls never appear under a closed optional disclosure;
- station/group/plot filters constrain page one, later pages, CSV, and JSON equally;
- ST72 shows 72 plots and ST12 shows 12; both can be selected independently;
- desktop capture exposes three regions and a sticky save action;
- mobile retains the ordered four-step flow;
- cloud authority adapters neither mutate edge-owned plots in cloud-primary mode nor
  report a pending gateway command as a confirmed save;
- cloud attachments remain available and failures remain recoverable.

### 9.2 Backend and contract tests

- authorization is applied before scope resolution;
- inaccessible/unknown station and group filters fail closed;
- pagination and export share filter normalization;
- multi-plot finalization remains atomic and idempotent;
- catalog dependency and requiredness validation rejects stale incompatible input;
- catalog seeds, generated fragments, bundled databases, and profile copies pass
  parity checks;
- cloud plot-snapshot listing is workspace-scoped and read-only.

### 9.3 Required repository gates

Edge minimum:

```bash
node scripts/test-journal-schema.js
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
- Lysimeter operations show only compatible machinery;
- a normal Quick entry can reach review without opening More details;
- desktop capture uses the available workspace and keeps Save visible;
- attachments/conflict controls remain available where applicable;
- Status and Export research package controls remain absent.

If any acceptance check fails, restore the preserved image to `dev-local`, recreate
only `agrolink-backend`, verify health, and report the evidence.

## 11. Non-goals

- A general package shared at runtime between the two repositories.
- Cloud ownership of gateway-backed plots.
- New compliance certification or legal retention claims.
- Automatic machinery choice when more than one compatible choice exists.
- Reintroducing the Status filter or Export research package control.
- Deploying to any host other than `agro-link.ch`.
