# Spec-review prompts (round 2 — review the written specs)

**Created:** 2026-06-30
**Purpose:** Independent review of the written artifacts — ADR
(`docs/adr/2026-06-30-schema-and-contract-ownership.md`), Spec 1
(`docs/superpowers/specs/2026-06-30-edge-schema-migration-foundation-design.md`),
Spec 2 (`docs/superpowers/specs/2026-06-30-sync-contract-package-design.md`).
**How to use:** For each agent, send `COMMON PREAMBLE` + one `ROLE BLOCK`, and
attach the three documents.

---

## COMMON PREAMBLE (prepend to every role block)

```
You are reviewing two design specs and an ADR for an offline-first IoT firmware
project. Attached: an ADR (schema/contract ownership), Spec 1 (edge schema
migration foundation), Spec 2 (sync-contract package). Be critical and specific;
disagree with the design if it's wrong. Lead with your strongest objection.

System context (verified):
- LoRaWAN smart-irrigation gateways: each is a Raspberry Pi running Node-RED +
  SQLite (`farming.db`). The EDGE is the source of truth. A cloud server
  (PostgreSQL + Flyway/Java) MIRRORS edge state via JSON sync-event payloads;
  cloud→edge commands arrive by REST polling. UUIDs, not autoincrement IDs.
- ONE live production gateway whose history must not be lost; demo/test gateways
  are freely rebuildable. First production deployments are weeks away.
- Current state the specs respond to: NO migration ledger and no general runner
  exist; schema knowledge is triplicated and drifted across (a) a hand-authored
  full-CREATE seed, (b) an inline Node-RED node that on EVERY boot runs ~92
  idempotent ADD COLUMNs + a `devices` CHECK table-rebuild + ~24 data UPDATEs
  with all errors swallowed, and (c) an ops repair script; dated migrations/*.sql
  files are orphaned. A documented field history-loss incident was caused by an
  unfenced boot-time table rebuild cascading deletes into history tables (a
  FK-off fence was since added and is CI-guarded). Two drift bugs were already
  hotfixed (a stale `devices` CHECK missing a device type; a command schema
  missing two live commands).
- Decision (in the ADR): edge ordered migrations + a ledger own the SQLite DDL;
  cloud Flyway owns Postgres DDL independently; the cross-repo contract is a
  versioned sync event/payload schema that generates types/fixtures (never DDL);
  no shared SQLite↔Postgres DDL generator; a governance "kill-switch" deletes the
  contract package if it rots into a hand-maintained shadow.
```

---

## ROLE BLOCK A — Embedded SQLite reliability engineer (Spec 1 runner correctness)

```
Act as a staff embedded-systems / SQLite reliability engineer. Focus on whether
Spec 1's migration runner is CORRECT and SAFE on a live SQLite DB.
1. Is the transaction/lock model (BEGIN IMMEDIATE + busy_timeout + WAL) correct
   given Node-RED's shared async sqlite3 connection AND concurrent writers
   (LoRaWAN uplinks inserting during a migration)? Any deadlock/starvation path?
2. Is "deploy-triggered migration; boot = verifyHead + bootstrapFresh only" sound
   given `/data/db` persists across updates and some updates may be image
   reflashes (no deploy.sh run)? What breaks, and is the repair_required fallback
   enough?
3. The baseline migration (0001) must make "empty DB + replay == current field
   schema" for DBs that drifted via swallowed-error inline DDL. How can that
   equality actually be guaranteed? What are the failure modes of stamping
   existing field devices as "baseline applied"?
4. Per-object fingerprints via normalized-SQL hash for partial-application
   detection: is normalized hashing robust across SQLite versions, autoindex,
   and pragma differences, or will it churn on false positives?
5. Destructive-migration backup of DB+WAL+SHM + integrity_check/foreign_key_check
   — sufficient? What about WAL checkpoint state at backup time, or a busy WAL?
6. SQLite-specific reconciliation (CHECK rebuild, ADD COLUMN non-constant
   default, trigger drop/recreate): anything the spec gets wrong or omits?
7. The single biggest correctness risk in Spec 1, and exactly what you'd change.
```

---

## ROLE BLOCK B — SRE / release engineer, unattended edge fleets (operability & rollout)

```
Act as an SRE / release engineer responsible for fleets of unattended,
intermittently-connected edge devices. Focus on operability and the rollout, not
code style.
1. The cutover (P1-P4) stamps drifted field devices as "baseline applied." Is
   that safe? What's the validation gate before the runner ever touches the one
   live PRODUCTION device?
2. A destructive migration fails postflight on a device with no operator: the
   spec aborts, leaves last-good, records failed, sets repair_required. Then
   what? Is the device degraded until a human acts, and is that acceptable?
3. deploy.sh runs the runner before the Node-RED restart. What about interrupted
   deploy / power loss mid-migration / a backup-restore over a curl|ssh deploy
   path? Is recovery realistic in the field?
4. Observability: are the ledger + repair_required signal enough to know the
   fleet's schema state remotely? What telemetry is missing to operate this?
5. Rollback: the design is forward-only (no down-migrations). A bad migration is
   already applied to several devices. Is forward-only acceptable here, and
   what's the concrete recovery?
6. Standing up osi-server CI from zero PLUS osi-os CI in the pre-production
   window for a small team — realistic, or scope risk? What's the minimum viable
   CI that still gates this safely?
7. Biggest operational risk; would you ship Spec 1 before or after the first
   production deployment, and why?
```

---

## ROLE BLOCK C — Software architect, contract/API design (boundary, Spec 2, decomposition)

```
Act as a software architect specializing in cross-system contracts and API
boundaries. Focus on the boundary, the decomposition, and Spec 2.
1. Is the Spec1/Spec2 split clean — correct dependency direction, no hidden
   coupling? Is "migrations first, contract package later" right, given the
   contract drift is itself a live bug class?
2. The hard boundary "contract package generates types/fixtures, NEVER DDL" — is
   it enforceable in practice, or will pressure push DDL into it? Is a CI lint
   against DDL-shaped fields a real safeguard?
3. The kill-switch ("delete it if it rots into a shadow schema") — genuine
   safeguard or wishful governance? What concretely makes it enforceable?
4. Is "cross-repo contract = sync event/payload schema, each DB owns its DDL" the
   right durable boundary, or does it under-serve future needs (analytics, admin,
   reconciliation)?
5. Spec 2 defers source-format, generator tech, and versioning decisions. Are any
   of those load-bearing enough that deferring them risks rework in Spec 1? Which
   must be decided now?
6. Does the ADR's flip-condition list correctly bound when to revisit the
   rejected declarative-model approach? Anything mis-scoped?
7. The biggest architectural risk across the three documents, and what's missing
   entirely.
```
