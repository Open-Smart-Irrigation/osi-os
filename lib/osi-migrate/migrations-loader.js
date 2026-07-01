'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NAME_RE = /^(\d{4})__([a-z0-9_]+)\.sql$/;
const RISK_RE = /^(?:\uFEFF)?(?:[ \t]*\r?\n)*--\s*risk:\s*(additive|destructive)\s*(?:\r?\n|$)/;

function loadMigrations(dir) {
  const out = [];
  const seen = new Set();
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const match = NAME_RE.exec(file);
    if (!match) throw new Error(`bad migration filename: ${file} (expected NNNN__slug.sql)`);
    const version = Number(match[1]);
    if (seen.has(version)) throw new Error(`duplicate migration version: ${version}`);
    seen.add(version);
    const raw = fs.readFileSync(path.join(dir, file));
    const sql = raw.toString('utf8');
    const risk = RISK_RE.exec(sql);
    if (!risk) throw new Error(`migration ${file} missing '-- risk: additive|destructive' header`);
    out.push({
      version,
      name: file,
      slug: match[2],
      risk: risk[1],
      sql,
      checksum: crypto.createHash('sha256').update(raw).digest('hex'),
    });
  }
  return out.sort((a, b) => a.version - b.version);
}

module.exports = { loadMigrations };
