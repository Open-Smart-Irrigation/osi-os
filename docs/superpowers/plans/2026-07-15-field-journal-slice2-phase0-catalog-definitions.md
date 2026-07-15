# Field Journal — Slice 2 Phase 0: catalog definitions + labels delivery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the edge catalog endpoint deliver the template/layout `definition_json`, vocab `labels_json`/`constraints_json`, and product `composition_json` the capture UI needs to render forms, behind an opt-in `?include=definitions` flag that leaves the default lightweight index unchanged.

**Architecture:** One additive change inside the pure `osi-journal` module: `catalogDto` gains an `options` argument that attaches the parsed JSON fields when definitions are requested; `loadScopedCatalog` forwards the flag; the `/api/journal/catalog` route reads `?include=definitions`. No schema change, no flows.json change, no new route.

**Tech Stack:** Node.js pure module (`node:sqlite`, `node:test`), the existing journal test harness (`scripts/test-journal-api.js`), the repo verifier suite.

## Global Constraints

- Contract of record: `docs/superpowers/specs/2026-07-12-field-journal-design.md` §4.3–4.6 (vocab/templates/layouts/products) and §5.5 (catalog delivery). This plan is Phase 0 of `docs/superpowers/plans/2026-07-15-field-journal-slice2-gui.md`.
- **This is an edge module change, not a schema change.** It reads existing columns. Do not add a migration, do not touch `seed-blank.sql`, any `farming.db`, or `sync-init-fn`. `osi-schema-change-control` is therefore not triggered; `osi-flows-json-editing` is not triggered because `flows.json` is not edited (the route already exists and `catalogDto` is internal).
- **Both profiles must stay byte-identical.** Every edit to `conf/full_raspberrypi_bcm27xx_bcm2712/.../osi-journal/api.js` is copied verbatim to `conf/full_raspberrypi_bcm27xx_bcm2709/.../osi-journal/api.js`; `node scripts/verify-profile-parity.js` must pass before the final commit.
- Backward compatibility is a hard requirement: a request with no `include` param returns the current lightweight DTO byte-for-byte. The full variant is strictly additive.
- The catalog is owner-scoped; `?include=definitions` returns definitions only for the scoped catalog `loadCatalog(db, principal)` already resolves. It adds no new data source and no new auth surface.

---

## Design

The Slice-1 `catalogDto` (`osi-journal/api.js`) deletes the heavy JSON columns from every row: `labels_json`/`constraints_json` from vocab, `definition_json`/`labels_json` from templates and layouts, `composition_json` from products. That makes the endpoint a version index. The capture flow cannot render forms without the template/layout `definition_json` (sections, fields, `required_if`/`visible_if`, defaults), vocab `labels_json`/`constraints_json`, and product `composition_json` (nutrient derivation, U5).

**Chosen shape:** keep one route, add `?include=definitions`. Default response is unchanged. With the flag, each row additionally carries the **parsed** field(s), and the raw `*_json` strings still never appear on the wire.

**Full-variant wire shape** (what the GUI's Phase 3 types consume):

```
GET /api/journal/catalog?include=definitions  →
{
  catalog_version, catalog_hash,
  vocab:      [{ ...lightVocabRow,     labels: {<locale>: string}, constraints: object|null }],
  templates:  [{ ...lightDefinitionRow, labels: {<locale>: string}, definition: object }],
  layouts:    [{ ...lightDefinitionRow, labels: {<locale>: string}, definition: object }],
  products:   [{ ...lightProductRow,    composition: object }],
  mappings:   [ ...unchanged ]
}
```

`labels` is the whole locale map (§6.4 delivers labels in all enabled locales); the client picks the active language with an English fallback. This avoids a second per-locale file mechanism.

**File Structure**
- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js` — `catalogDto`, `loadScopedCatalog`, and the `/api/journal/catalog` route branch.
- Copy the edited file to `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js` (byte-identical).
- Modify `scripts/test-journal-api.js` — one test covering default-unchanged + include-definitions.

---

## Task 1: Failing test for the definitions variant

**Files:**
- Modify: `scripts/test-journal-api.js` (append one `test(...)` block near the other catalog/plot tests)

**Interfaces:**
- Consumes: `journal.loadScopedCatalog(db, principal, options?)` — the `options` third argument is what this task specifies and Task 2 implements. Harness helpers `new TestDb(name)` and `principal(overrides?)` already exist in the file.
- Produces: the behavioral contract Task 2 must satisfy.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-journal-api.js`:

```javascript
test('catalog delivers parsed definitions under include=definitions and stays light by default', async () => {
  const db = new TestDb('catalog-definitions');
  const owner = principal();

  // Default response: lightweight index, no parsed or raw heavy fields.
  const light = await journal.loadScopedCatalog(db, owner);
  assert.ok(light.vocab.length > 0, 'seed catalog has vocab rows');
  assert.ok(light.templates.length > 0, 'seed catalog has templates');
  assert.ok(!('labels' in light.vocab[0]), 'light response omits parsed labels');
  assert.ok(!('labels_json' in light.vocab[0]), 'raw labels_json never leaks');
  assert.ok(!('definition' in light.templates[0]), 'light response omits definition');
  assert.ok(!('definition_json' in light.templates[0]), 'raw definition_json never leaks');

  // Full response: parsed definition/labels/constraints/composition attached.
  const full = await journal.loadScopedCatalog(db, owner, { includeDefinitions: true });
  const template = full.templates[0];
  assert.equal(typeof template.definition, 'object', 'definition_json parsed to object');
  assert.notEqual(template.definition, null);
  assert.equal(typeof template.labels, 'object', 'labels_json parsed to object');
  assert.ok(!('definition_json' in template), 'raw definition_json never leaks in the full variant');
  assert.ok(!('labels_json' in template), 'raw labels_json never leaks in the full variant');

  const layout = full.layouts[0];
  assert.equal(typeof layout.definition, 'object', 'layout definition parsed');

  const vocab0 = full.vocab[0];
  assert.equal(typeof vocab0.labels, 'object', 'vocab labels parsed');
  assert.ok('constraints' in vocab0, 'vocab carries constraints (object or null)');
  assert.ok(!('constraints_json' in vocab0), 'raw constraints_json never leaks');

  if (full.products.length > 0) {
    assert.equal(typeof full.products[0].composition, 'object', 'product composition parsed');
    assert.ok(!('composition_json' in full.products[0]), 'raw composition_json never leaks');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-journal-api.js 2>&1 | tail -20`
Expected: FAIL on the new test — the full variant currently returns the same light rows, so `typeof template.definition` is `'undefined'` (the `options` argument is ignored).

---

## Task 2: Implement the definitions variant (bcm2712)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js` — `catalogDto` (currently near line 284), `loadScopedCatalog` (near line 322), and the `/api/journal/catalog` route branch (near line 2781).

**Interfaces:**
- Consumes: `loadCatalog(db, principal)` (unchanged) returning `catalog.vocabByCode`/`templates`/`layouts`/`products` Maps of rows whose `labels_json`/`constraints_json`/`definition_json`/`composition_json` are raw JSON strings.
- Produces: `loadScopedCatalog(db, principal, options?)` and `catalogDto(catalog, options?)` where `options.includeDefinitions === true` attaches parsed fields.

- [ ] **Step 1: Add a local JSON parse helper above `catalogDto`**

Insert immediately before `function catalogDto(` in `api.js`:

```javascript
function parseCatalogJson(raw, fallback) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}
```

- [ ] **Step 2: Rewrite `catalogDto` to accept `options` and attach parsed fields**

Replace the whole `function catalogDto(catalog) { ... }` with:

```javascript
function catalogDto(catalog, options) {
  const includeDefs = !!(options && options.includeDefinitions);
  const vocab = [...catalog.vocabByCode.values()].map(function(row) {
    const output = Object.assign({}, row);
    if (includeDefs) {
      output.labels = parseCatalogJson(row.labels_json, {});
      output.constraints = parseCatalogJson(row.constraints_json, null);
    }
    delete output.labels_json;
    delete output.constraints_json;
    return output;
  }).sort(function(left, right) { return left.code.localeCompare(right.code); });
  const definitions = function(index) {
    return [...index.values()].flatMap(function(versions) {
      return [...versions.values()].map(function(row) {
        const output = Object.assign({}, row);
        if (includeDefs) {
          output.labels = parseCatalogJson(row.labels_json, {});
          output.definition = parseCatalogJson(row.definition_json, {});
        }
        delete output.labels_json;
        delete output.definition_json;
        return output;
      });
    }).sort(function(left, right) { return left.code.localeCompare(right.code) || left.version - right.version; });
  };
  const products = [...catalog.products.values()].map(function(row) {
    const output = Object.assign({}, row);
    if (includeDefs) {
      output.composition = parseCatalogJson(row.composition_json, {});
    }
    delete output.composition_json;
    return output;
  }).sort(function(left, right) { return left.product_uuid.localeCompare(right.product_uuid); });
  const mappings = (catalog.mappings || []).map(function(row) {
    const output = Object.assign({}, row);
    delete output.id;
    return output;
  });
  return {
    catalog_version: Number(catalog.version),
    catalog_hash: catalog.hash,
    vocab,
    templates: definitions(catalog.templates),
    layouts: definitions(catalog.layouts),
    products,
    mappings,
  };
}
```

- [ ] **Step 3: Forward `options` through `loadScopedCatalog`**

Replace:

```javascript
async function loadScopedCatalog(db, principal) {
  return catalogDto(await loadCatalog(db, principal));
}
```

with:

```javascript
async function loadScopedCatalog(db, principal, options) {
  return catalogDto(await loadCatalog(db, principal), options);
}
```

- [ ] **Step 4: Read `?include=definitions` in the catalog route**

Find the catalog branch (`if (method === 'GET' && requestPath === '/api/journal/catalog')`) and replace its body:

```javascript
    if (method === 'GET' && requestPath === '/api/journal/catalog') {
      return respond(200, await loadScopedCatalog(db, principal, {
        includeDefinitions: query.include === 'definitions',
      }));
    }
```

(`query` is already defined a few lines above as `msg.req && msg.req.query || {}`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `node scripts/test-journal-api.js 2>&1 | tail -20`
Expected: PASS — all journal API tests, including the new one.

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js scripts/test-journal-api.js
git commit -m "feat(journal): deliver catalog definitions + labels under ?include=definitions"
```

---

## Task 3: Mirror to bcm2709 and verify profile parity

**Files:**
- Overwrite: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js` with the bcm2712 copy.

**Interfaces:** none new — byte-for-byte identity of the two module copies.

- [ ] **Step 1: Copy the edited module file to the bcm2709 profile**

Run:
```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js
```

- [ ] **Step 2: Confirm the two files are identical**

Run:
```bash
diff conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js \
     conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js && echo IDENTICAL
```
Expected: prints `IDENTICAL` (no diff output).

- [ ] **Step 3: Run profile parity**

Run: `node scripts/verify-profile-parity.js 2>&1 | tail -5`
Expected: pass with no journal `api.js` mismatch.

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js
git commit -m "chore(journal): mirror catalog-definitions change to bcm2709 (profile parity)"
```

---

## Task 4: Full field-journal gate

**Files:** none — verification only.

- [ ] **Step 1: Run both module unit test suites**

Run:
```bash
node conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/index.test.js 2>&1 | tail -5
node conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/index.test.js 2>&1 | tail -5
```
Expected: both pass.

- [ ] **Step 2: Run the journal script gates from `.github/workflows/field-journal.yml`**

Run:
```bash
node scripts/test-journal-api.js 2>&1 | tail -3
node scripts/test-journal-schema.js 2>&1 | tail -3
node scripts/test-journal-lifecycle.js 2>&1 | tail -3
node scripts/test-journal-command-path.js 2>&1 | tail -3
node scripts/verify-sync-contract.js 2>&1 | tail -3
node scripts/test-journal-bootstrap.js 2>&1 | tail -3
```
Expected: each passes. (The catalog change is additive and touches no sync/bootstrap/schema surface, so these are regression guards, not new coverage.)

- [ ] **Step 3: No further commit**

Verification-only task; the change already committed in Tasks 2–3. If any gate fails, stop and fix under the failing gate's owning skill before proceeding.

---

## Self-review

- **Spec coverage:** §5.5 catalog delivery is extended without breaking the version index; §4.4/§4.5 definitions, §4.3 vocab labels/constraints, and §4.6 product composition all reach the client under the flag. The design doc's Phase 0 requirement (definitions + labels delivery) is fully met by one opt-in variant.
- **Placeholder scan:** every step carries the literal code or command; no "add validation" / "similar to" placeholders.
- **Type consistency:** `catalogDto(catalog, options)`, `loadScopedCatalog(db, principal, options)`, and `options.includeDefinitions` are named identically across Tasks 1–2; the wire shape in the Design section matches the fields Task 2 attaches (`labels`, `constraints`, `definition`, `composition`) and is what the Slice-2 GUI Phase 3 types must mirror.
- **Backward compatibility:** Task 1 asserts the default (no-flag) response omits both parsed and raw heavy fields, so existing consumers and the Phase 1–2 GUI reading surface are unaffected.
