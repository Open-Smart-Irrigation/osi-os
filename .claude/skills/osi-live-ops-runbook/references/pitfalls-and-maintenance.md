# Common mistakes and maintenance

Part of the osi-live-ops-runbook skill; read SKILL.md first.

## Common mistakes

- Running `curl ... | sh` for the deploy step instead of download-then-run, then
  trusting a printed "Deploy complete" without checking the actual SSH/curl exit
  code — a 404'd fetch can still exit the pipeline at 0.
- Treating `export.csv` returning `401` as a failure. It is the healthy state for an
  unauthenticated request; `404`/`500` is the actual failure signal.
- `scp`-ing any `farming.db` onto a Pi that has ever been provisioned — there is no
  scenario in normal operations where this is correct.
- Using `localhost` in an on-Pi curl/wget call and getting a confusing connection
  refusal that's actually an IPv6 resolution artifact, not a dead service.
- Sending a bare `CLOSE` to a STREGA valve "to be safe" — it is not part of the
  supported command set; use a short `OPEN_FOR_DURATION` or the cancel endpoint.
- Resetting a password or token to get unblocked instead of asking the operator.
- Treating a loaded SSH key or working `ssh` check against `osicloud.ch` or a
  customer-hosted instance as permission to proceed there.
- Hand-editing `schema_object_fingerprints` instead of using
  `restamp-fingerprints.js`, or running that script without first confirming the
  live schema is actually correct.
- Forgetting that `run_schema_migration()` SKIPs entirely when
  `/data/db/farming.db` doesn't exist yet — a brand-new Pi ends up at exactly
  the bundled seed schema, not seed-plus-migrations.
- Trusting `=== Deploy complete. ===` without reading the self-check verdict
  printed above it. A failed post-flip probe auto-rolls the flows+GUI pair back
  while any committed DB migration stays applied — the
  `ROLLED BACK: flows+GUI -> payloads/<prev>` line (or its absence) tells you
  which payload is actually live, not the closing banner.
- Restarting Node-RED by hand right after a deploy "just to be sure."
  `deploy.sh` already restarted it — once around the schema migration, once
  after the payload flip — and another restart only muddies which restart
  produced the state you're observing.

---

## Provenance and maintenance

Re-verify these if this skill feels stale (the deploy flow and safety rules change
rarely, but do change):

- Seeding guard logic: `grep -n "seed_db_if_missing" -A 25 deploy.sh` (repo root).
- Download-then-run tunnel command still matches practice: check the current
  operator wrapper behavior contract (not in this repo) or re-derive from
  `deploy.sh`'s own header comment plus this skill's rationale.
- `osi-bootstrap` stamp/START logic:
  `cat conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap`.
- `export.csv` route + auth gate: `grep -n "export.csv" -A2` and
  `grep -n "function verifyBearer" -A15` against
  `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`.
- STREGA cancel route: `grep -n "valves/:deveui/cancel"` against the same
  `flows.json`.
- `restamp-fingerprints.js` behavior: `sed -n '1,30p' scripts/restamp-fingerprints.js`.
- Gateway-health table/migration: `sed -n '1,10p' database/migrations/ordered/0002__gateway_health.sql`.
- Payload flip/self-check/rollback:
  `grep -n "stagePayload\|flipTo\|PAYLOAD_KEEP_N\|AUTO-ROLLING-BACK" deploy.sh`
  and `sed -n '1,40p' scripts/deploy-payload-swap.js`.
- Migration-runner delivery: `grep -n "run_schema_migration" -A 30 deploy.sh`.
- Canary-gate defaults: `head -20 scripts/deploy-canary-gate.js`.
- package.json helper declarations: `grep -n "file:" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json`.
- `functionExternalModules` flag: `grep -n functionExternalModules feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`.
- Prime directives / asymmetry framing: `sed -n '13,32p' docs/engineering-playbook.md`.
- Host access gate wording: `sed -n '/Host access gate/,/^---/p' AGENTS.md`.
- Cross-check this file still matches `AGENTS.md` "Live-deploy safety rules" verbatim
  intent — if that section is edited, this skill's Prime Safety Rules section needs
  a matching pass.
