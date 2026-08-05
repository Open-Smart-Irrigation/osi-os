# Journal catalog contract artifact

`journal-catalog.json` is generated; never hand-edit it. It holds the same rows,
in the same DTO shape and the same order, that the edge serves at
`GET /api/journal/catalog?include=definitions` — for the global (non-principal)
rows only: `scope='core'` vocab and their mappings, every template and layout
version, and `scope='core'` products, stamped with the `journal_catalog_state`
version and hash of `database/farming.db`. A caller's own `scope='custom'` vocab
and `scope='farm'` products are **not** here and cannot be: the edge merges those
per principal at request time (`osi-journal/catalog.js` `loadScopedRows`).

Regenerate with `node scripts/export-journal-catalog.js` after any catalog
change, and re-vendor it to osi-server (`backend/src/main/resources/journal-catalog/`)
in the same change. `scripts/verify-journal-catalog-vendor.sh` and the
osi-server twin gate CI on both sides: `.github/workflows/journal-catalog.yml`
here (on `AgroLink`), `.github/workflows/backend-ci.yml` there.

osi-server serves this artifact to its GUI and compares its `catalog_version` /
`catalog_hash` against the values a gateway advertises at bootstrap
(`journal_catalog_version` / `journal_catalog_hash`). A mismatch disables cloud
capture for that gateway rather than writing entries the gateway's own catalog
cannot validate.
