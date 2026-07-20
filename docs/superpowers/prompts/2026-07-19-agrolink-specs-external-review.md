# External review prompt — AgroLink specs and ADR (v2 documents)

Hand the text below (everything inside the quote block) to the reviewer, together with
repo access at commit `4fcb4b60` or the three files attached. This brief targets the v2
documents. Review history: v1 had one full content review; the second round reviewed an
earlier version of this brief, not the specs. The machinery v2 added (union-rule
resolver, scheduler authority, USER aggregate, registration bootstrap) has had no
content review as a whole, so a first-order sweep matters as much as gap-hunting.

---

> You are reviewing design documents for a production IoT system, not code. Be adversarial: your job is to find what breaks, not to approve. The v1 versions had one full content review; the v2 revisions since then added substantial new machinery (a union-rule ownership resolver, scheduler authority, a USER sync aggregate, registration-time bootstrap) that has never been reviewed as a whole. Do a first-order sweep of everything, with extra weight on the v2 additions.
>
> ## System context (self-contained)
>
> OSI OS is an irrigation platform with two tiers. Each site runs a Raspberry Pi edge gateway: Node-RED serves ~118 REST endpoints and a React GUI; SQLite (`/data/db/farming.db`, WAL mode) holds canonical state behind a facade that serializes **all** access through one shared connection and one global FIFO queue. A frozen boot node recreates 31 sync triggers on every restart, so migrations must never edit existing trigger bodies. Sensor outbox events are written by SQLite triggers and polled by the cloud. The cloud (osi-server, Spring Boot + PostgreSQL) mirrors edge state; the edge is authoritative; sync contract changes require paired PRs in both repos.
>
> A new deployment (AgroLink, for the Agroscope research institute) changes the usage shape: one Pi 5 hub (16 GB RAM, NVMe RAID) shared by 20–30 researcher accounts with cloud sync enabled. The current edge is single-tenant: `users` has no roles, handlers authenticate but do not authorize per resource, and every aggregate is bound to a single owner column.
>
> ## Documents under review (v2, at commit `4fcb4b60`)
>
> 1. `docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md`: scoped multi-user access. Owned∪granted union model, three roles, cached reads vs uncached physical-effect checks, migration-owned triggers only, registration-time bootstrap, per-gateway cloud membership.
> 2. `docs/superpowers/specs/2026-07-19-agrolink-hub-hardening-design.md`: operational hardening. Queue benchmark plus bounded read-only snapshot pool, keyset-paginated exports, archive-first raw-telemetry retention, NVMe layout with mandatory off-hub backups.
> 3. `docs/adr/2026-07-19-scoped-multiuser-access-model.md`: the decision record, including rejected alternatives and flip conditions.
>
> ## Key claims to challenge
>
> - **Union-rule completeness.** Access is the union of shipped owner columns and new grant rows, and every legacy owner-filtered query must be enumerated and extended (the journal API is the dense cluster). What does one missed query do: deny a legitimate grantee, or leak across scopes? Is the union rule itself right when ownership and grants disagree, e.g. the plot owner left the project and their grant was revoked: who retains access, and is that the intended answer?
> - **Trigger strategy.** New sync behavior propagates only through migration-owned triggers registered in `MIGRATION_OWNED_TRIGGERS`, never the frozen boot node. Can anything else still revert or drop them (seed replay, schema repair scripts, parity-verifier blind spots)? Does the `USER` aggregate trigger catch every role/disable mutation path, including direct SQL maintenance and future nodes?
> - **Actuation authorization.** Physical-effect paths use uncached membership checks and synchronous `disabled_at` reads; scheduler origin is internal and unforgeable; schedules are disabled when the owning account loses scope. Attack the seams: check-to-execution races, scheduler-origin forgery via flow context, schedule re-enable by a non-admin, epoch invalidation ordering under concurrent writes.
> - **Bootstrap and lockout.** The first registration on a scoped hub with zero admins becomes admin in one transaction; public registration then closes. Two concurrent first registrations? The only admin gets disabled? Recovery on an offline hub with no reachable admin? Interaction between the registration-time rule and the in-place-upgrade backfill?
> - **Cloud membership mapping.** Role and enabled state are per-gateway membership on the `LinkedGatewayAccount` axis; the global cloud `User.role` is untouched. Where does the mapping edge `user_uuid` ↔ cloud membership break: edge-originated accounts the cloud has not ingested, events referencing unknown `user_uuid`s, disable state diverging between edge and cloud?
> - **Contract sequencing.** The cloud deploys acceptance of the three new aggregates before any edge producer emits; schema install is split from event emission. What happens in the skew windows: old cloud/new edge, re-linked hub with partial history, rejected-aggregate recovery, tombstone replay, `sync_version` gap detection?
> - **Queue topology and read snapshots.** Writes stay on the single serialized queue; heavy reads move to a bounded read-only connection pool. Is the pool safe under WAL (snapshot age, checkpoint interaction, readers starving the writer)? Does the combined load (concurrent dashboards, ingestion, rollups, scope checks, exports, backups) fit the latency budget, measured rather than asserted?
> - **Retention archive-first gating.** Raw telemetry prune is gated on a verified off-hub archive, coverage manifests, acknowledgements, and delivered sync-cursor position. Can any path still delete unarchived raw rows? Are the cursor semantics correct for a cloud that re-links after the prune?
>
> ## Output format
>
> Findings ordered by severity (blocker / should-fix / consider), each with: document and section reference, the failure scenario in one sentence, and a concrete suggested change. End with a one-paragraph verdict: is this design safe to implement as written?
>
> If you have repo access, verify claims against the actual schema (`database/seed-blank.sql`, `database/migrations/ordered/`), the flow file (`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`), and `scripts/verify-runtime-schema-parity.js` before reporting a finding; do not report contradictions you have not checked. If you were given only the attached files and cannot reach the repo, mark any schema- or flow-dependent claim as unverified rather than assuming it holds.

---

## Notes for the requester

- This is the **broad first-pass variant**. For a focused second opinion, replace "Key claims to challenge" with a single named claim (the actuation-authorization and union-rule bullets are the strongest candidates); broad prompts dilute attention, so do not run both variants against the same reviewer.
- Expected cost of skipping the review: the union-rule completeness question (a silent leak or denial across ~118 endpoints) and the trigger strategy (a silent-revert class) are the two places where being wrong is expensive and hard to detect late.
- The prompt works standalone; the file paths assume the reviewer can read the repo at `4fcb4b60`. Otherwise attach the three files.
- If this round also comes back clean, the next gate is not a fourth review but the Phase A implementation plan.

## Revision history

- v3.1 (2026-07-19): framing corrected per the third reviewer — the v2 documents had one content review, not two; the brief now asks for a first-order sweep of the v2 additions rather than implying they were already reviewed.
- v3 (2026-07-19): retargeted at the v2 documents (`4fcb4b60`); claims named instead of numbered (positional references drifted); revocation angle moved into the actuation-authorization claim (the v1 gap it described is fixed); em-dash budget restored.
- v2 (2026-07-19): added combined-load, user_uuid-ordering, and admin-drift angles; corrected the facade constructor count.
- v1 (2026-07-19): initial brief against the v1 specs (`64b52864`).
