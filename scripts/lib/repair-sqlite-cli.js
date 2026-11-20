'use strict';
// Stock Node 20 has no node:sqlite. One SQLite CLI connection owns each fenced
// transaction. Private FIFOs provide blocking, streamed replies without native
// addons or dependence on Node's undocumented pipe file descriptors.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

function parseRow(text, big) {
  // CLI metadata and sequence queries contain JSON scalars. Preserve integer
  // tokens before JSON.parse can round them. SQL text remains a quoted string.
  const marker = '$eb19_integer';
  const encoded = text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token[0] === '"' || /[.eE]/.test(token)) return token;
    const value = BigInt(token);
    if (!big && (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))) {
      throw new Error('SQLite integer requires lossless bigint mode');
    }
    return big ? JSON.stringify({ [marker]: token }) : token;
  });
  return JSON.parse(encoded, (_key, value) => value && typeof value === 'object' &&
    !Array.isArray(value) && Object.keys(value).length === 1 && typeof value[marker] === 'string'
    ? BigInt(value[marker]) : value);
}

class DatabaseSync {
  constructor(file) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb19-sqlite-'));
    this.pending = '';
    this.buffer = Buffer.alloc(65536);
    const request = path.join(this.dir, 'request');
    const response = path.join(this.dir, 'response');
    this.errors = path.join(this.dir, 'errors');
    try {
      fs.writeFileSync(this.errors, '', { flag: 'wx', mode: 0o600 });
      execFileSync('mkfifo', ['-m', '600', request, response]);
      this.child = spawn('sh', ['-c', 'exec sqlite3 -init /dev/null -batch -json "$1" < "$2" > "$3" 2> "$4"',
        'repair-sqlite', file, request, response, this.errors], { stdio: 'ignore' });
      this.input = fs.openSync(request, fs.constants.O_WRONLY);
      this.output = fs.openSync(response, fs.constants.O_RDONLY);
      this.exec('PRAGMA busy_timeout=30000');
    } catch (e) { this.close(); throw e; }
  }
  line() {
    for (;;) {
      const index = this.pending.indexOf('\n');
      if (index >= 0) {
        const line = this.pending.slice(0, index);
        this.pending = this.pending.slice(index + 1);
        return line;
      }
      const count = fs.readSync(this.output, this.buffer);
      if (!count) return null;
      // Keep multibyte text intact across read boundaries.
      this.decoder ||= new (require('node:string_decoder').StringDecoder)('utf8');
      this.pending += this.decoder.write(this.buffer.subarray(0, count));
    }
  }
  *query(sql, big = false) {
    if (/^\s*\./m.test(sql)) throw new Error('SQLite CLI metacommands are forbidden in repair SQL');
    const marker = 'EB19_' + crypto.randomBytes(16).toString('hex');
    const start = fs.statSync(this.errors).size;
    fs.writeFileSync(this.input, sql.trim() + '\n;\n.print ' + marker + '\n');
    let failure;
    for (;;) {
      const line = this.line();
      if (line === null) throw new Error('SQLite CLI connection ended: ' + fs.readFileSync(this.errors, 'utf8').slice(start));
      if (line === marker) break;
      // SQLite -json emits one object per line, surrounded by an array.
      let row = line.trim().replace(/^\[/, '').replace(/[,]?\]$/, '').replace(/,$/, '');
      if (!row || failure) continue;
      try { yield parseRow(row, big); }
      catch (e) { failure = e; }
    }
    const error = fs.readFileSync(this.errors, 'utf8').slice(start);
    if (error) throw new Error(error.trim());
    if (failure) throw failure;
  }
  exec(sql) { for (const _row of this.query(sql)) { /* drain reply before next statement */ } }
  prepare(sql) {
    let big = false;
    const bind = values => {
      const chunks = sql.split('?');
      if (chunks.length !== values.length + 1) throw new Error('unsupported repair statement parameters');
      return chunks.map((chunk, index) => chunk + (index < values.length
        ? typeof values[index] === 'bigint' || typeof values[index] === 'number' ? String(values[index])
          : "'" + String(values[index]).replace(/'/g, "''") + "'" : '')).join('');
    };
    return {
      setReadBigInts(value) { big = value; },
      all: (...values) => [...this.query(values.length ? bind(values) : sql, big)],
      get: (...values) => [...this.query(values.length ? bind(values) : sql, big)][0],
      iterate: () => this.query(sql, big),
      run: (...values) => this.exec(bind(values)),
    };
  }
  close() {
    let failure;
    try {
      if (this.input !== undefined && this.output !== undefined) {
        fs.writeFileSync(this.input, '\n.quit\n');
        while (this.line() !== null) { /* wait for connection closure, including rollback */ }
      }
    } catch (error) { failure = error; }
    finally {
      if (this.input !== undefined) { fs.closeSync(this.input); this.input = undefined; }
      if (this.output !== undefined) { fs.closeSync(this.output); this.output = undefined; }
      if (this.child) this.child.unref();
      if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    }
    if (failure) throw failure;
  }

}

function checkRuntime() {
  execFileSync('sqlite3', ['-version'], { stdio: 'pipe' });
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER REFERENCES p(id)); BEGIN; INSERT INTO c VALUES(1)');
    if (!db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite FK introspection is unavailable');
    db.exec('ROLLBACK; PRAGMA foreign_keys=ON');
    if (db.prepare("SELECT json_valid('{\"probe\":1}') AS ok").get().ok !== 1 || db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw new Error('SQLite JSON/FK enforcement capability is unavailable');
    if (db.prepare('SELECT 1 AS n -- trailing SQL comment').get().n !== 1) throw new Error('SQLite statement framing failed');
    const integer = db.prepare('SELECT 9223372036854775807 AS n');
    integer.setReadBigInts(true);
    if (integer.get().n !== 9223372036854775807n) throw new Error('SQLite integer transport failed');
    return { node: process.version, adapter: 'sqlite3-cli', available: true };
  } finally { db.close(); }
}
module.exports = { DatabaseSync, checkRuntime };
