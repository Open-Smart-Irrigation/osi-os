#!/usr/bin/env node
'use strict';

// Issue #331 R3 contract step. Run once from the root of the P-based osi-os
// implementation checkout, after the flow editor and the green snapshot test:
//   node docs/superpowers/plans/issue-331-contract-edit-r3.js
// It replaces only ValveActuation.properties.archived_at.description in
// resources.schema.json and the `archived_at` bullet under "## Valve actuation
// archive" in canonicalization.md. Both inputs must be the P bytes. This file is
// a review artifact until the plan's execution stage.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(process.cwd());
const planDir = path.join(root, 'docs/superpowers/plans');
const schemaPath = path.join(root, 'docs/contracts/sync-schema/resources.schema.json');
const canonPath = path.join(root, 'docs/contracts/sync-schema/canonicalization.md');
// SHA-256 of P blobs fb3825f2d5687ca53fbda6511faeb7bc9af9a142 and f66f7816aa8ebf9282767d7e7ac33ae01523a02e.
const schemaPreSha256 = 'e3f5e932c9a09a33088d83b9ef25b4a38baec420b3277c2b93d4b95af56e5128';
const canonPreSha256 = '9e66a6fd1abe03f05e9f6f2fae9ae1a92d2a455da4532ad9664c742dbbe63463';

const newDescription = "Last-write-wins snapshot field: this table has no sync_version bookkeeping column of its own (unlike ValveSettings). The current edge producer derives archived_at from observed_close_at when present, otherwise commanded_at; expected_close_at is a separate planned endpoint and does not order archive updates. archived_at is a canonical UTC ISO timestamp with millisecond precision, never wall-clock 'now'. Re-emitting an unchanged row yields the same archived_at. A later observed close may advance archived_at, while a correction to other scalar fields may retain the same archived_at. Both cloud application paths accept an equal archived_at and apply the later-arriving payload; they ignore a strictly older archived_at. ValveRuntime.as_of differs on the producer side: the edge reads it fresh from the wall clock at each emission, so it effectively never ties. See canonicalization.md.";

const newBullet = [
  '- `archived_at` — UTC instant, canonical millisecond-precision ISO. The current',
  "  edge producer derives it from the row's `observed_close_at` when present,",
  '  otherwise `commanded_at`. `expected_close_at` remains the separate planned',
  '  endpoint and does not order archive updates. The producer never uses wall-clock',
  '  `now` for this field. Re-emitting an unchanged row gives the same `archived_at`.',
  '  A later observed close may advance it; a correction to another scalar field',
  '  may leave it unchanged. This table (`valve_actuation_expectations`) has no',
  '  `sync_version`/`updated_at` bookkeeping column of its own, so both cloud',
  '  application paths compare `archived_at` to the stored value. An incoming',
  '  strictly older value is ignored. On an equal value, the later-arriving',
  '  payload applies, allowing a corrected trigger or volume field to land.',
  '  `ValveRuntime.as_of` differs on the producer side: the edge reads it fresh',
  '  from the wall clock at each emission, so it effectively never ties.',
].join('\n') + '\n';

const bulletStart = '\n- `archived_at` — UTC instant, canonical millisecond-precision ISO. This\n';
const bulletEnd = "\n- `status` — the edge panel's 8-state vocabulary";

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

assert.equal(fs.realpathSync(__dirname), planDir, 'run the committed editor from the repo root that contains it');

// resources.schema.json: one JSON string value changes, nothing else.
const schemaBytes = fs.readFileSync(schemaPath);
assert.equal(sha256(schemaBytes), schemaPreSha256, 'schema pre-image must be P');
const schemaText = schemaBytes.toString('utf8');
const schemaBefore = JSON.parse(schemaText);
const oldDescription = schemaBefore.definitions.ValveActuation.properties.archived_at.description;
assert.equal(typeof oldDescription, 'string', 'old archived_at description');
assert.ok(oldDescription.includes('COALESCE(observed_close_at, expected_close_at, commanded_at)'), 'old formula in description');
const oldEncoded = JSON.stringify(oldDescription);
const newEncoded = JSON.stringify(newDescription);
assert.equal(count(schemaText, oldEncoded), 1, 'old description occurs once as encoded');
assert.equal(count(schemaText, newEncoded), 0, 'new description absent before edit');
const schemaAfter = schemaText.replace(oldEncoded, () => newEncoded);
const schemaExpected = JSON.parse(schemaText);
schemaExpected.definitions.ValveActuation.properties.archived_at.description = newDescription;
assert.deepEqual(JSON.parse(schemaAfter), schemaExpected, 'only the archived_at description changes');
assert.equal(count(schemaAfter, newEncoded), 1, 'new description once');

// canonicalization.md: the 20-line archived_at bullet becomes the 13-line bullet.
const canonBytes = fs.readFileSync(canonPath);
assert.equal(sha256(canonBytes), canonPreSha256, 'canonicalization pre-image must be P');
const canonText = canonBytes.toString('utf8');
assert.equal(count(canonText, bulletStart), 1, 'archived_at bullet start once');
assert.equal(count(canonText, bulletEnd), 1, 'status bullet start once');
const start = canonText.indexOf(bulletStart) + 1;
const end = canonText.indexOf(bulletEnd, start) + 1;
assert.ok(end > start, 'status bullet follows archived_at bullet');
const oldBullet = canonText.slice(start, end);
assert.equal(count(oldBullet, '\n'), 20, 'old bullet is 20 lines');
assert.ok(oldBullet.includes('`COALESCE(observed_close_at, expected_close_at,'), 'old formula in bullet');
assert.ok(oldBullet.includes('`as_of` stays strict-`>` (P3-E1 ruling)'), 'old runtime contrast in bullet');
assert.equal(count(canonText, newBullet), 0, 'new bullet absent before edit');
const canonAfter = canonText.slice(0, start) + newBullet + canonText.slice(end);
assert.equal(count(canonAfter, newBullet), 1, 'new bullet once');

const schemaOut = Buffer.from(schemaAfter, 'utf8');
const canonOut = Buffer.from(canonAfter, 'utf8');
fs.writeFileSync(schemaPath, schemaOut);
fs.writeFileSync(canonPath, canonOut);

assert.equal(Buffer.compare(fs.readFileSync(schemaPath), schemaOut), 0, 'schema written');
assert.equal(Buffer.compare(fs.readFileSync(canonPath), canonOut), 0, 'canonicalization written');
console.log(`issue-331 contract editor: resources.schema.json ${sha256(schemaOut)}; canonicalization.md ${sha256(canonOut)}`);
