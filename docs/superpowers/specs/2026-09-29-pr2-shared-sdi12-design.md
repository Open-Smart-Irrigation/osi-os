# PR2 support through the shared SDI-12 framework

Date: 2026-09-29

Status: Proposed design for review. Hardware acquisition remains unverified.

## Outcome and agreed scope

Support Delta-T PR2/4-SDI-12 and PR2/6-SDI-12 through the existing Dragino
SDI-12-LB/LS integration. Install and validate PR2/6 first. The first installation
uses mineral-soil calibration. Both local and cloud dashboards must show moisture
at each depth and its history. Automatic irrigation is outside this work.

The user requires a reusable SDI-12 framework: adding another probe that measures
already-supported quantities must not require another device card, chart page,
telemetry transport, or cloud ingestion implementation. Probe-specific work belongs
in the profile, acquisition adapter, normalization rules, and captured fixtures.

Guided setup includes choosing the probe and applying its acquisition
configuration to the Dragino. This design proposes the same workflow from local
and cloud dashboards; the edge remains responsible for validation and execution.
One probe per Dragino and a fixed installation are the proposed initial boundary.

## Current implementation

The edge already has `DRAGINO_SDI12`, a profile registry in
`osi-sdi12-normalize`, segment reassembly, identification, and persistent recipe
deployment. Existing VWC channels cover both PR2 variants. Cloud history hashing
already includes these channels; PR2 does not need a new telemetry quantity.

The remaining coupling is visible in current code:

- `osi-sdi12-recipe` exposes `compileSentekRecipe(layout)`.
- `Sdi12SettingsModal` selects the acquisition workflow by Sentek profile ID.
- The sync resource contract accepts `SentekChannelLayout` for
  `sdi12_channel_layout_json`.
- The cloud `Sdi12SoilCard` and SDI-12 history selection assume VWC/VIC layouts.
- Both PR2 profiles are provisional, permit variable counts, and lack default
  depths and identity matching.

The existing PR2 documentation uses `M!` as though it returned VWC. Delta-T
documents permittivity for this command. The specification therefore requires
correction of the command semantics before these profiles become operational.

## Approach

Extend the existing static profile registry and shared acquisition workflow.
Resolve each saved probe configuration into a versioned channel description used
by normalization, presentation, and synchronization. Preserve the existing
canonical measurement fields and transport.

A PR2-only branch through the current screens would be smaller initially, but
would repeat the Sentek coupling for the next probe. A replacement telemetry store
and runtime plugin loader would expand this task without being needed for PR2.
The proposed approach changes the shared boundaries that PR2 actually exercises.

## Shared configuration and channel description

Keep converter identity (`DRAGINO_SDI12`) separate from probe profile identity.
The edge-owned profile defines supported settings, expected response structure,
normalization, default physical depths, and acquisition capabilities.

Use an additive, versioned configuration contract rather than changing the
meaning of the deployed Sentek layout. It must represent:

- Profile ID and definition version.
- Confirmed SDI-12 address.
- Profile-specific validated settings, including calibration selection.
- Stable channel keys, canonical quantities, units, physical depths, and display
  order, resolved by the edge.
- Configuration revision and the separately observed acquisition revision.

Display metadata must be bounded data, never executable transforms or browser
supplied command strings. The existing channel manifest remains authoritative
for canonical keys, quantities, and units. A profile references that manifest;
it does not introduce a competing unit registry.

Keep calibration and sensor-module concepts inside their owning profiles.
PR2 must not be represented as an EnviroSCAN module to make existing UI work.
Saved legacy Sentek layouts resolve through a compatibility adapter. Upgrading
software must preserve their channel IDs, depths, transformations, and acquisition
behavior without sending configuration downlinks.

Future probes using existing quantities and supported channel counts need only a
profile, acquisition adapter where necessary, and verification fixtures. A new
physical quantity or a larger channel count may still require an explicit channel
contract and storage extension. SDI-12 compatibility alone does not establish
measurement meaning or make an arbitrary probe safe to normalize.

## PR2 profile behavior

| Profile | Channels | Default depths |
|---|---|---|
| `DELTAT_PR2_4` | `vwc_1` through `vwc_4` | 10, 20, 30, 40 cm |
| `DELTAT_PR2_6` | `vwc_1` through `vwc_6` | 10, 20, 30, 40, 60, 100 cm |

Require the selected variant's exact response count. Do not infer a different
model from an incomplete reading or expose an arbitrary count setting for PR2.
Confirm the physical installation depths during setup; changing a label must not
reorder response positions or rename historical channels.

The first supported calibration is standard mineral soil with VWC stored in
percent. Delta-T documents `aM3!` / `aC3!` as the factory mineral VWC-percent
commands. `aM!` / `aC!` return permittivity, and `aM1!` / `aC1!` return mineral
VWC as a fraction. Never decide the unit from the numerical magnitude.

Command settings can be modified inside the probe. Commissioning must establish
the selected command's units and calibration from probe settings and captured
responses. Merely selecting a profile, receiving an ACK, or counting four/six
values cannot establish this. Custom calibration editing is outside the initial
scope; modified or unverified settings must be reported explicitly.

Automatic identification requires evidence that the identity response
distinguishes the variant. Otherwise identify the family and ask the operator to
select PR2/4 or PR2/6. Never silently choose one variant.

## Acquisition and deployment

Provide one acquisition interface with profile-specific compilers behind it.
Keep the deployment state machine, queue ownership, retry rules, and observation
checks shared. Preserve the verified Sentek compiler's output through regression
fixtures while introducing a PR2 compiler.

The compiler receives only validated canonical configuration. It determines the
addressed measurement and data-retrieval commands, response cuts, power timing,
payload mode, and reporting interval. The UI never sends arbitrary SDI-12
commands or Dragino frame bytes.

PR2 data retrieval must collect all values from one measurement cycle. The manual
allows sequential responses to span multiple `D` commands; concurrent retrieval
has a larger response limit. The implementation plan must choose the acquisition
sequence from protocol evidence and captures, not copy the existing illustrative
single-`D0!` recipe. Power timing and LoRaWAN segmentation likewise require their
own PR2 evidence. Retain the ordinary 20-minute reporting interval as the proposed
default, without speeding up transmission merely to apply configuration.

Saving desired configuration and applying hardware configuration remain separate
actions. Preserve queue conflict detection, visible partial failures, and the last
observed-compatible configuration. Queued means accepted by ChirpStack. Active
requires compatible post-delivery observations plus verified measurement
semantics; it does not mean laboratory calibration accuracy has been established.

During a configuration transition, readings must retain their established
interpretation or remain unavailable. Never decode an old recipe's payload with
the newly desired profile simply because a save succeeded. Expose acquisition
failure without presenting old readings as fresh.

## Shared local and cloud UI

Use the resolved channel description for the existing SDI-12 card, history series,
and export labels on both sides. Render configured channels even before their
first reading, with an unavailable value and an explicit observation timestamp.
Group history axes by compatible units and preserve real zero values.

Setup is capability-driven: show the settings and actions supported by the
profile. Probe-specific acquisition logic stays outside React. Current Sentek
module editing remains available through its profile capabilities.

Cloud setup requests travel through REST pending commands. They remain pending
until the edge validates and applies them. Device receipt and observed acquisition
are later states, not synonyms for edge acceptance. All physical side effects
execute on the edge through the same workflow used by the local dashboard.

## Synchronization and compatibility

Reuse existing device synchronization and canonical measurement/history paths.
Replicate the resolved configuration and bounded acquisition status needed by the
cloud UI. Detailed queue-item bookkeeping stays local to the edge.

Introduce capability negotiation for the additive configuration and command
contract. Cloud must not send new setup commands to an older gateway. Existing
Sentek resource fields keep their original interpretation throughout rollout.
Unknown descriptor versions must produce an explicit unsupported-configuration
state while preserving historical measurements.

Both incremental events and bootstrap/reconciliation must preserve configuration
and channel identity. Updates after an offline period must converge without
replaying an old acquisition request as a new physical action. Profile versions
and calibration changes must not silently reinterpret previously stored values.

## Verification and release criteria

Acceptance covers the shared path, not only PR2 parsing:

1. PR2/4 and PR2/6 each produce exactly their configured VWC channels in percent
   with correct depth labels on local and cloud cards, history, and exports.
2. Wrong counts, invalid responses, incomplete segments, and unverified units
   cannot produce plausible moisture values or silently change probe variant.
3. Mineral percent and fractional/permittivity examples prove command semantics
   are explicit; no heuristic rescales a value based on its magnitude.
4. Existing Sentek/ TriSCAN and other supported profiles retain their measured
   quantities, UI behavior, history, and acquisition semantics.
5. A fixture-only additional profile using existing quantities exercises setup,
   display, history, and sync without a new device-name branch in those layers.
6. Local and cloud setup use the same edge validation and deployment workflow;
   duplicate commands, queue conflicts, interrupted applies, rollback, and stale
   configuration revisions have deterministic outcomes.
7. Incremental sync, bootstrap, offline catch-up, and older-peer behavior preserve
   channel metadata and readings. Both repos verify identical contract mirrors.
8. Relevant migration, profile-parity, flow, frontend, and cloud gates pass, with
   independent plan review and verification under the engineering playbook.

Hardware validation records the PR2 variant and firmware, Dragino firmware,
identity and calibration readback, complete SDI-12 response bytes, exact converter
configuration, and resulting LoRaWAN uplinks. Include multi-response and boundary
length cases where supported. Validate the stored values against a trusted
reading of the same measurement mode.

PR2/6 is the first hardware target. Software coverage for PR2/4 is required in the
same implementation, but its hardware validation status remains separate until a
PR2/4 capture exists. Do not label either provisional recipe as field-verified on
the strength of synthetic tests.

## Sources and implementation boundaries

- [Delta-T PR2 product specifications](https://delta-t.co.uk/product/pr2/).
- [PR2 SDI-12 manual](https://delta-t.co.uk/wp-content/uploads/2016/09/PR2_SDI-12-_User_Manual_version_4_1.pdf),
  especially the command table and extended configuration commands on pages 49–52.
- [Existing edge integration](../../devices/dragino-sdi12.md).
- [Existing acquisition design](2026-08-29-sdi12-recipe-deployment-design.md).
- [Engineering playbook](../../engineering-playbook.md).

The implementation plan must pin concrete schema/API names, configuration
revision handling, history metadata behavior, and tested compiler frames after
reviewing both repositories. This specification proposes those shared boundaries;
it does not assert that current code already implements them. No production
deployment or live device reconfiguration is part of writing this specification.
