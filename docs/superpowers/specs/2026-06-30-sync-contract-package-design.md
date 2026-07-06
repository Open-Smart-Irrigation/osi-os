# Sync-Contract Package (cross-repo)

**Status:** Draft — spec. **Tranche A** (command/event codegen) is plannable now and runs **in parallel** with Spec 1; **Tranche B** (full payload contract, release-compatibility, versioning) needs its own brainstorm later. See §7.
**Created:** 2026-06-30
**Scope:** Both repos — the edge↔cloud payload/protocol contract surface. **No new DDL project.**
**Decision record:** [ADR — Schema and cross-repo contract ownership](../../adr/2026-06-30-schema-and-contract-ownership.md)
**Relationship to Spec 1:** Tranche A runs in parallel with [Edge Schema Migration Foundation](./2026-06-30-edge-schema-migration-foundation-design.md) (Spec 1); both stand up CI in both repos, so they coordinate on the shared CI workflow.
**Depends on:** the CI workflow Spec 1 introduces (shared); otherwise independent of Spec 1's runtime.

---

## 1. Problem

The edge and cloud agree on a wire contract — sync event payloads, command types, resource shapes — but that contract is only partially formalized (`docs/contracts/sync-schema/`) and **generates nothing**. Typed consumers (edge TypeScript, cloud Java) are hand-maintained, so they drift from the contract and from each other.

Verified instance: `commands.schema.json` was missing two live commands (`REMOVE_DEVICE_FROM_ZONE`, `UNCLAIM_DEVICE`) that both the edge registry and the cloud issuer implement (fix prepared in `41f431a9` on branch `fix/cmd-schema-remove-device-from-zone-drift`, **pending integration** — until merged, `verify-sync-contract` fails on the working branch). The command-type **registry** and the **schema enum** are two sources that drifted, caught only by a verifier that happened to exist. There is no generation and no systematic per-type drift gate.

This is the gap Spec 1 deliberately leaves open: Spec 1 fixes field-data safety but does nothing for cross-repo payload/event consistency.

## 2. Decision

Establish a **governed sync-contract package**: versioned event/payload/command/resource schemas at the sync layer that are the single source for those definitions and that **generate** the typed consumers and test fixtures. Each database keeps owning its own DDL; this package owns only the externally-meaningful contract. CI proves generated == committed and registry == schema. It **never** generates DDL.

This is the cross-repo layer of Option C in the ADR. It builds on the existing convention in `docs/contracts/sync-schema/README.md` ("files here are the source of truth; mirrored copies in osi-server must match bytewise; contracts versioned per file").

## 3. What the contract defines

The externally-meaningful protocol — not storage:

- Event names and **versions**; command types; resource types.
- Stable IDs and natural keys (UUIDs/EUIs), and which side is authoritative.
- Timestamp semantics (encoding, timezone, ordering).
- `null` vs absent vs **tombstone** behavior.
- Idempotency keys and effect-keys (extends existing `effect-keys.md`).
- Conflict / version-precedence rules.
- **Release compatibility / capability advertisement** — how the cloud learns what an old or long-offline gateway supports (advertised capability/contract version), the rule for *when it may issue newer commands*, and forward/backward payload compatibility. Old-gateway and current fixtures gate this in CI. (A full edge↔cloud `contract_version` *handshake* may phase in later, but the capability/compatibility model is defined here, not deferred entirely.)
- **Fixtures** — canonical example payloads for old and current versions, used by both repos' tests.

## 4. Generated artifacts (committed; no runtime codegen)

From the versioned contract source, generate and commit into both repos:

- Edge: TypeScript types/enums for events, commands, resources (consumed by the GUI and flow validation).
- Cloud: Java constants/records/validators for the same (consumed by the issuer and sync mapper).
- Both: payload **fixtures** for tests.
- Docs: a human-readable contract reference.

No device or server loads the generator at runtime; artifacts are build-time and committed, consistent with the offline/supply-chain posture.

## 5. Governance invariant (the kill-switch)

This package may exist **only if**:

1. It generates artifacts that are actually consumed (types/fixtures imported by real code in both repos), and
2. CI proves generated == committed (no manual edits to generated files) and that the command/event **registry matches the schema enum** in both directions (`verify-sync-contract.js`, generalized to events + cross-repo).

**Enforced by the merge gate, not goodwill:** the *first* contract-package PR must land the generator, the committed generated outputs, the real production-code consumers (imports), fixture tests, and the CI equality check — together. A PR that adds contract source without generated-and-consumed artifacts cannot merge. If the package later degrades into a hand-maintained shadow nobody generates from, **delete it** and fall back to plain documented JSON Schema + verifiers — a stale non-executable model is worse than no model.

**Hard boundary (structural, not just a lint):** the package describes logical payloads and externally-meaningful types only. Enforce by: (a) generated artifacts restricted to DTOs / validators / constants / fixtures — no DDL emitters; (b) contract source forbidden from carrying table / column / index / FK / default / storage metadata (CI rejects such fields); (c) a CI rule that the contract package neither imports from nor is imported by `database/migrations/`, the runner, or Flyway. It must **not** become a SQLite/Postgres schema generator.

## 6. CI enforcement

- Generated == committed (both repos).
- Registry == schema enum (generalize `verify-sync-contract.js`).
- Cross-repo bytewise parity of the contract source (per the existing `sync-schema/README.md` rule).
- Fixtures validate against their schema versions; old-gateway fixtures still validate under compatibility rules.

## 7. Tranches

### Tranche A — command/event codegen (plannable now, parallel with Spec 1)

The narrow, executable slice that closes the live drift class. Decisions for it are fixed here:

- **Scope:** generate and verify, for both repos, the enums that exist in the schema **today** — **command-type** enums (`commands.schema.json`) and the event operation enum (`events.schema.json` `properties.op.enum`) — plus their required-field shapes; commit them; wire **real imports** in the edge (GUI / flow validation) and cloud (issuer / sync mapper); add the merge-gate CI (§5, §6).
- **Event op enum is in scope for this tranche.** `events.schema.json` now carries explicit operation names such as `DEVICE_DATA_APPENDED`, `ZONE_LOCATION_UPSERTED`, and `ZONE_CONFIG_UPSERTED`; Tranche A verifies the schema enum, edge emitters, shipped trigger definitions, and cloud `EdgeSyncService` switch stay aligned.
- **Zone op split:** `ZONE_LOCATION_UPSERTED` and `ZONE_CONFIG_UPSERTED` are explicit edge event ops in this tranche. The zone outbox trigger intentionally gives location changes precedence over config changes, so a mixed location+config zone update emits `ZONE_LOCATION_UPSERTED`; config-only edits emit `ZONE_CONFIG_UPSERTED`; structural zone edits still emit `ZONE_UPSERTED`; deletes emit `ZONE_DELETED`.
- **Boot trigger touch:** the shipped `sync-init-fn` boot schema block remains frozen for new schema behavior. This tranche only mirrors the already-existing zone outbox trigger definition for contract-parity hardening, so fresh and legacy boot paths do not emit server-unknown ops. Replacing boot DDL with the migration runner remains out of scope.
- **Source format:** extend the existing per-file JSON Schemas in `docs/contracts/sync-schema/` (the documented source of truth) — no new catalog format.
- **Generator location:** osi-os is canonical; osi-server consumes the committed generated output (per `sync-schema/README.md`).
- **First consumers:** the command/event enums that drifted (the `REMOVE_DEVICE_FROM_ZONE`/`UNCLAIM_DEVICE` class). Richer payload DTOs stay hand-written initially.
- **Governed by the §5 merge gate** from its first PR: generator + generated outputs + consumers + fixtures + CI equality, together.
- **Coordinates with Spec 1 on CI:** shares the CI workflow Spec 1 stands up; the generalized `verify-sync-contract` (events + cross-repo parity) is the gate both rely on.

### Tranche B — full payload contract & compatibility (later; own brainstorm)

Requires its own focused brainstorm before a plan:

- Full event/payload DTOs + validators beyond enums.
- The release-compatibility / capability-advertisement model (§3) and whether/when an edge↔cloud `contract_version` **handshake** is introduced.
- Versioning mechanics for events/payloads (per-file vs a contract-version field) and old-gateway fixture compatibility gates.

## 8. Out of scope

Any database DDL generation (rejected, see ADR); edge SQLite migrations (Spec 1); column renames; replacing Flyway or the edge migration runner.
