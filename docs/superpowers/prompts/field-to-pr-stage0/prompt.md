# Worker Prompt — Field-to-PR Stage 0

You are implementing **Stage 0 of the OSI Field-to-PR pipeline** — the intake
system that lets field users submit bug/improvement requests from the edge GUI,
syncs them to OSI Server, applies server-side triage/publish gates, and creates
GitHub issues. No agent, no runner, no draft PRs — Stage 0 is the data pipeline
only.

## Repos

- **osi-os** (edge): `/home/phil/Repos/osi-os` — edge schema, Node-RED intake,
  React form, sync contract
- **osi-server** (cloud): `/home/phil/Repos/osi-server` — server intake,
  admin console, publish gate, GitHub integration

Each repo gets its own feature branch and PR. Do not cross-commit.

## Read first (your requirements)

1. **Spec:** `docs/superpowers/specs/2026-07-08-field-to-pr-design.md` in
   osi-os — the full design with trust boundaries, data flow, request schema,
   redaction, rate limits, publish gate, status-back. **Read the whole thing.**
2. **Plan:** `docs/superpowers/plans/2026-07-08-field-to-pr-stage0.md` in
   osi-os — 8 tasks with exact code. Execute task-by-task using
   `superpowers:subagent-driven-development`.
3. **AGENTS.md** in both repos. Architecture, sync model, file locations,
   conventions.
4. **Engineering playbook:** `docs/engineering-playbook.md` — the working loop.

## Execution method

Use `superpowers:subagent-driven-development` — dispatch a fresh subagent per
task, review between tasks.

## Task overview

| Task | Repo | What |
|------|------|------|
| 1 | osi-os | Sync contract extension + edge schema (`0005__field_work_requests.sql`) + bundled DBs + deploy.sh |
| 2 | osi-os | Node-RED intake endpoint + delivery worker in `flows.json` |
| 3 | osi-os | React form (Support & Requests page) + i18n + tests |
| 4 | osi-server | Flyway migration + intake service + persistence |
| 5 | osi-server | Publish gate (GitHub issue creation via App) |
| 6 | osi-server | Admin console (React) for triage/publish |
| 7 | osi-os | Status-back command handler (WORK_REQUEST_STATUS) |
| 8 | both | E2E verification: submit → sync → triage → publish → status |

## Skills to load

Load these skills BEFORE touching the corresponding files:

- **`osi-schema-change-control`** — before writing migration 0005 (Task 1)
- **`osi-flows-json-editing`** — before editing flows.json (Task 2)
- **`osi-react-gui-patterns`** — before writing the React form (Task 3)
  (if this skill exists; otherwise follow existing GUI patterns)
- **`osi-sync-contract-awareness`** — before modifying sync contracts (Task 1)
  (if this skill exists)

## Non-negotiable invariants

1. **No production access.** Do not SSH to / inspect / run commands on
   `osicloud.ch`. The test server is `server.opensmartirrigation.org`.

2. **Never overwrite `/data/db/farming.db`** on a live Pi. `deploy.sh` seeds
   the bundled DB only when the target is absent.

3. **Every public artifact is built from sanitized fields only.**
   `diagnostics_json`, real gateway EUI, local username, email, tokens, logs,
   and raw private metadata never leave OSI Server.

4. **Edge schema change is additive but high-consequence.** Migration
   `0005__field_work_requests.sql`, `seed-blank.sql`, all 7 bundled DBs,
   `deploy.sh` live repair, and schema verifiers must all update in one PR.

5. **`flows.json` edits are script-only** and applied to both profiles:
   `bcm2712` canonical and `bcm2709` mirror.

6. **Status commands are inert.** `WORK_REQUEST_STATUS` updates
   `improvement_requests` state/display text only — must not trigger
   actuator/downlink logic.

7. **Rate limits:** 10/day per EUI, 50/week per EUI, 10/day per IP, 500 global
   pending unlinked circuit breaker.

8. **GitHub App integration.** If app config is absent, publish attempts fail
   closed with `PUBLISH_BLOCKED_CONFIG` — no public issue created.

## Definition of done

### osi-os

```bash
node scripts/test-contract-schemas.js
node scripts/verify-sync-flow.js
node scripts/verify-db-schema-consistency.js
node scripts/test-improvement-requests-schema.js
cd web/react-gui && npm run test:unit
cd web/react-gui && npm run build
```

### osi-server

```bash
cd backend && ./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend
cd frontend && npm run test:unit
```

### E2E (Task 8)

```bash
# Submit from a test gateway → verify sync → verify server storage →
# triage → publish → verify GitHub issue created → verify status-back
```

## Report

Open two PRs (osi-os edge + osi-server intake). In each PR:

```markdown
## Summary
- [what changed]

## Test plan
- [ ] All verification gates green
- [ ] Schema verifiers pass
- [ ] Sync contract tests pass
- [ ] flows.json wiring tests pass
- [ ] React form renders and submits
- [ ] Server intake processes WORK_REQUEST_SUBMITTED events
- [ ] Rate limits enforced
- [ ] Publish gate creates GitHub issue with sanitized content
- [ ] Status-back updates edge improvement_requests
- [ ] E2E: submit → sync → triage → publish → status verified
```
