# ADR — Static, in-repo device plugin registry

**Status:** Accepted — 2026-05-28
**Closes:** [`osi-os#8`](https://github.com/Open-Smart-Irrigation/osi-os/issues/8) (Integration of plugin system)
**Supersedes:** —
**Superseded by:** —

## Context

Adding a new LoRaWAN device type to OSI OS today requires coordinated edits across many layers, with no single place documenting the contract a device type must satisfy:

1. `database/seed-blank.sql` — extend the `devices.type_id` `CHECK` constraint.
2. `web/react-gui/src/types/farming.ts` — extend the `DeviceType` union.
3. `conf/full_raspberrypi_bcm27xx_bcm{2709,2712}/files/usr/share/flows.json` — add a Node-RED ingest branch on `application/+/device/+/event/up` filtered by ChirpStack device profile.
4. `conf/.../node-red/codecs/*.js` — add a payload codec module.
5. `web/react-gui/src/components/farming/*Card.tsx` — add a dashboard card.
6. `scripts/chirpstack-bootstrap.js` — add the ChirpStack device profile creation.
7. `scripts/repair-pi-schema.js` — register a table-rebuild step if the new type changes the `devices.type_id` CHECK list (SQLite cannot alter constraints in place).
8. `scripts/verify-*.js` — extend the relevant verifiers.

The current device catalog (KIWI_SENSOR, STREGA_VALVE, DRAGINO_LSN50, TEKTELIC_CLOVER, SENSECAP_S2120, AQUASCOPE_LORAIN, plus the Chameleon calibration surface and MClimate work in flight) was added this way. The result is correct but every addition risks forgetting one of the eight steps, and the contract is implicit — readers must reverse-engineer it from existing additions.

The issue body of `#8` asks for a "plugin system" to make this self-contained.

## Decision

This ADR records two decisions and explicitly defers the registry implementation:

### Decided: scope of a future plugin

When a "plugin" eventually exists in OSI OS, it will be a **static, in-repo bundle** that owns:

- catalog metadata (device-type identifier, human-readable name, vendor),
- payload codec (one JS module per uplink direction),
- ingest mapping (Node-RED branch entry plus ChirpStack device-profile name guard),
- dashboard card mapping (one React component path),
- schedule-metric provider (if the device produces a metric the irrigation scheduler can consume),
- command capability (allowed downlink command types, with payload schema),
- verification fixture (canonical uplink frames + expected decoded shapes).

### Decided: what plugins will NOT be

- **No remote loading.** Plugins do not arrive at runtime. The gateway will not download, fetch, or evaluate arbitrary JavaScript from the cloud or any third party. All plugin code is committed to this repo, reviewed via PR, and shipped inside the OSI OS image build.
- **No NPM-style registry.** No external plugin marketplace, no third-party package resolution at boot.
- **No hot-reload.** Adding a plugin requires an image rebuild and a deploy, same as any other code change.

These constraints are non-negotiable because of OSI OS's offline-first and supply-chain-trust requirements. The gateway runs unattended in the field; the operator cannot vet arbitrary plugin code in real time.

### Deferred: the registry data structure and verifier

Building `device-registry/registry.json` plus `scripts/verify-device-registry.js` is **explicitly out of scope** for this ADR. The decision to defer rests on three points:

1. The repo currently has exactly one consumer of "what device types exist" — the existing catalog. A registry that only describes what's already hard-coded would duplicate information, not abstract it.
2. The shape of "what a plugin needs to own" is fuzzy until a concrete second-party plugin tries to fit it. Designing the registry against zero examples risks over-fitting to the first-party catalog and under-fitting whatever the second-party plugin actually needs.
3. The next first-party device integration (MClimate T-Valve, Slice 10 of the open-issues plan) will exercise every one of the eight integration steps and serve as the forcing function — if MClimate's integration reveals a registry would help, that's when to write it.

The registry should be written when, and only when, a candidate plugin exists that is genuinely separable from the OSI OS image build process — for example, a third-party sensor SDK that wants to declare its codec, card, and ingest rule from outside the `conf/` and `web/` trees.

## Consequences

### Short-term (now → next 1–2 device additions)

- Nothing changes operationally. MClimate T-Valve and any other near-term device additions follow the 8-step list in [AGENTS.md § "Adding a new device type"](../../AGENTS.md#adding-a-new-device-type) by hand.
- AGENTS.md is updated to reference this ADR so the next agent or contributor sees the deferred-registry rationale before re-proposing one.

### Long-term (when a second-party plugin appears)

- This ADR's "scope of a future plugin" list becomes the registry schema's required fields.
- The "what plugins will NOT be" constraints become hard verifier checks.
- A new ADR may revisit the deferral with the concrete candidate's contract as input.

### Risks accepted

- The 8-step integration remains error-prone. Mitigation is already in place via the various `verify-*.js` scripts — each one catches one specific class of "forgot to update X" mistake. The verifier set should grow alongside any new integration, but it does not need a plugin registry to do so.
- Two parallel device-integration efforts could conflict on the same files (`flows.json`, `farming.ts`, etc.). The cost is the same as any other branch-merge conflict; not a plugin-system problem.

## Alternatives considered

### A. Dynamic plugin loading (rejected)

A `/etc/osi-plugins/` directory that the gateway scans at boot, loading any JS modules it finds. Rejected because (a) it breaks the offline-first trust model — the gateway would execute code with no prior review; (b) supply-chain risk on an unattended device in the field is unacceptable; (c) Node-RED's flow JSON is already an in-repo artifact, so the "plugin" would have to splice itself into a running flow at boot, which is fragile.

### B. NPM-style plugin registry (rejected)

Resolve plugins from a package registry at image build or first boot. Rejected for the same supply-chain reasons as (A), plus the practical problem that OSI OS targets gateways with intermittent or no internet.

### C. Per-device-type monorepo subdirectory (deferred to second-party trigger)

Restructure `conf/...` and `web/...` so each device type lives in `plugins/<device-type>/{codec.js,card.tsx,ingest.json,catalog.json,verify.js}`. The build script assembles all subdirectories into the OSI OS image. Attractive in principle, but reorganizing the existing 6+ device types now would touch hundreds of files for zero immediate user-visible benefit. Deferred to the same trigger as the registry itself: a real candidate that needs the separation.

### D. Build a registry now without the rest (rejected as half-measure)

`device-registry/registry.json` that lists each current type with pointers to its codec/card/ingest. Rejected per CLAUDE.md ("no premature abstraction") — without a second user, the registry is a duplicate index of what the code already declares. Worse, a future plugin candidate would force the registry shape to change, and existing entries would have to be rewritten with no behavioral benefit.

## How to apply this decision

- When considering a "plugin system" proposal, point at this ADR and ask: "is there a concrete plugin candidate that is genuinely external to the OSI OS image build?" If no, the answer is "follow the 8-step integration."
- When adding a device type, follow [AGENTS.md § "Adding a new device type"](../../AGENTS.md#adding-a-new-device-type) and extend the relevant verifier scripts.
- When a second-party plugin candidate does appear, open a new ADR that supersedes this one. Use this ADR's "scope of a future plugin" list as the starting point for the registry schema.
