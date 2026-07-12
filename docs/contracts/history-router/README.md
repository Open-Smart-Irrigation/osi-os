# History API Router Golden Vectors

These fixtures are owned by `osi-os`.

They pin the behavior of the `history-api-router-fn` flow node (History API
Router — the largest embedded-JS node at ~76K chars) while its pure
router-glue functions move into `osi-history-router`.

- `MANIFEST.json` lists every captured case.
- `cases/*.input.json` describes the fixture request (method, path, query
  params, auth token), database seed rows, and fixed clock.
- `cases/*.expected.json` is the response captured from the pre-extraction
  flow node (status code, headers, body).

The harness (`scripts/capture-history-router-vectors.js`) executes the
`history-api-router-fn` node's `func` body against a `node:sqlite` fixture
database with a pinned clock (`2026-07-10T12:00:00.000Z`) and the real
`osi-history-helper` module. It covers four representative route families:

| Case | Route | What it exercises |
|---|---|---|
| `card-summary` | `GET /api/history/zones/:id/cards` | Card classification, source detection, preference map, ordering |
| `series-aggregate` | `GET /api/history/zones/:id/cards/:cardId/data` | Range parsing, aggregation, series building, calendar, profiles |
| `workspace-create` | `POST /api/history/workspaces` | Workspace normalization, JSON parsing, validation |
| `csv-export` | `GET /api/history/zones/:id/export.csv` | CSV generation via `osiHistory.buildZoneExportCsv` delegation |

These fixtures are behavior-preservation artifacts for the edge extraction
only. They do not define an osi-server mirror or cross-repo contract.

## Verification

```bash
# Capture (regenerate fixtures from the current node — only run before extraction)
node scripts/capture-history-router-vectors.js --capture

# Verify (assert current node reproduces the captured fixtures)
node scripts/capture-history-router-vectors.js --verify
```

Both modes exit 0 on success, non-zero on any mismatch.
