'use strict';
// A cassette folder is a pair: cassette.json and the fixture.db it was
// recorded on (meta.fixtureSha256). A recording stages the new fixture beside
// the old pair and only replaces fixture.db once the cassette is accepted, so
// a refused recording leaves the previous pair intact. A replay refuses a
// folder whose fixture.db does not match the cassette.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function stagedFixture(out) {
  return { final: path.join(out, 'fixture.db'), staged: path.join(out, 'fixture.db.next') };
}

// Drop the staged fixture of a refused or failed recording.
function discardStaged(out) {
  fs.rmSync(stagedFixture(out).staged, { force: true });
}

// Move the staged fixture into place, then write the cassette that names it.
function commitRecording(out, cassetteText) {
  const { final, staged } = stagedFixture(out);
  if (fs.existsSync(staged)) fs.renameSync(staged, final);
  fs.writeFileSync(path.join(out, 'cassette.json'), cassetteText);
}

// { ok: true } | { ok: true, warning } when the cassette names no hash |
// { ok: false, reason }.
function checkReplayFixture(cassetteDir, meta) {
  const want = meta && meta.fixtureSha256;
  const file = path.join(cassetteDir, 'fixture.db');
  if (!want) return { ok: true, warning: 'cassette has no meta.fixtureSha256; fixture.db not checked' };
  if (!fs.existsSync(file)) return { ok: false, reason: 'fixture.db missing; cassette expects sha256 ' + want };
  const got = sha256File(file);
  if (got !== want) return { ok: false, reason: 'fixture.db sha256 ' + got + ' does not match cassette meta.fixtureSha256 ' + want };
  return { ok: true };
}

module.exports = { sha256File, stagedFixture, discardStaged, commitRecording, checkReplayFixture };
