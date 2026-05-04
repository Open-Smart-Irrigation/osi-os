# Sync Contract and Schema Refactor Design

**Date:** 2026-05-03
**Status:** Integrated into [Consolidated Remediation Design](2026-05-03-consolidated-remediation-design.md)

---

This earlier sync-specific design has been folded into the umbrella remediation spec:

- [docs/specs/2026-05-03-consolidated-remediation-design.md](2026-05-03-consolidated-remediation-design.md)

Use the consolidated remediation design as the authoritative spec for the `osi-os` and `osi-server` refactor. It now includes the sync contract details from this draft:

- event apply contract and per-event statuses
- command lease and REST ACK/NACK design
- schema and JSON Schema contract direction
- sync retention, indexing, and health endpoint
- `EdgeSyncService` decomposition
- horizontal scaling readiness
- rollout phases and first implementation slice
