'use strict';
// SSH access to the Silvan gateway: read-only SQLite queries, a couple of
// read-only shell reads, and token minting.
//
// Everything here is read-only against the gateway filesystem. The harness
// mutates gateway STATE only through the HTTP API and MQTT, never by writing
// to /data/db/farming.db directly -- so a case that passes proves the real
// code path works, not that the harness can write rows.

const { execFile } = require('node:child_process');

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|ATTACH|PRAGMA\s+\w+\s*=)\b/i;

class Ssh {
  constructor(cfg) {
    this.host = cfg.sshHost;
    this.user = cfg.sshUser;
    this.key = cfg.sshKey;
    this.dbPath = cfg.dbPath;
    this.secretPath = cfg.secretPath;
  }

  _args(command) {
    return [
      '-i', this.key,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'LogLevel=ERROR',
      '-o', 'ConnectTimeout=15',
      this.user + '@' + this.host,
      command,
    ];
  }

  exec(command, { timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile('ssh', this._args(command), { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error('ssh failed (' + command.slice(0, 80) + '): ' + (stderr || err.message)));
          return;
        }
        resolve(stdout);
      });
    });
  }

  // Read-only SQLite query. Rejects any statement that could mutate the DB --
  // the guardrail that keeps this harness from ever reseeding a live database.
  async sql(query, { json = true } = {}) {
    if (FORBIDDEN_SQL.test(query)) {
      throw new Error('SAFETY: refusing to run a mutating SQL statement over ssh: ' + query.slice(0, 120));
    }
    const mode = json ? '-json' : '-line';
    const escaped = query.replace(/'/g, "'\\''");
    const out = await this.exec(
      "sqlite3 -readonly " + mode + " 'file:" + this.dbPath + "?mode=ro' '" + escaped + "'"
    );
    if (!json) return out;
    const trimmed = out.trim();
    if (!trimmed) return [];
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      throw new Error('sqlite3 -json returned unparseable output: ' + trimmed.slice(0, 200));
    }
  }

  async sqlOne(query) {
    const rows = await this.sql(query);
    return rows.length ? rows[0] : null;
  }

  async sqlScalar(query) {
    const row = await this.sqlOne(query);
    if (!row) return null;
    const keys = Object.keys(row);
    return keys.length ? row[keys[0]] : null;
  }

  // Mints an edge API token USING THE GATEWAY'S OWN SECRET, ON THE GATEWAY.
  //
  // The secret file never leaves the Pi: the HMAC is computed in a one-shot
  // node process over ssh and only the finished token comes back. That is
  // strictly safer than copying the secret to the workstation, and it is the
  // only way to produce a token with a chosen `exp` (needed for the
  // expired-token assertions) since /auth/login always issues exp = now + 7d.
  //
  // Token format (conf/.../node-red/osi-scope-helper/index.js + flows.json
  // node `auth-process-result`):
  //   payload    = { userId, username, iat, exp }   (ms epoch)
  //   payloadB64 = base64url(JSON.stringify(payload))
  //   token      = payloadB64 + '.' + base64url(HMAC-SHA256(secret, payloadB64))
  async mintToken({ userId, username, iat = Date.now(), exp = Date.now() + 7 * 24 * 3600 * 1000 }) {
    const payload = JSON.stringify({ userId: Number(userId), username: String(username), iat, exp });
    const script = [
      'const fs=require("fs"),c=require("crypto");',
      'const paths=["' + this.secretPath + '","/var/lib/node-red/.node-red/osi_auth_token_secret"];',
      'let s="";for(const p of paths){try{s=fs.readFileSync(p,"utf8").trim();if(s)break;}catch(e){}}',
      'if(!s){console.error("no auth secret on gateway");process.exit(2);}',
      'const b=Buffer.from(process.argv[1]).toString("base64url");',
      'process.stdout.write(b+"."+c.createHmac("sha256",s).update(b).digest("base64url"));',
    ].join('');
    const escaped = (str) => "'" + String(str).replace(/'/g, "'\\''") + "'";
    const out = await this.exec('node -e ' + escaped(script) + ' ' + escaped(payload));
    const token = out.trim();
    if (!token.includes('.')) throw new Error('mintToken returned no token: ' + out.slice(0, 200));
    return token;
  }

  // Node-RED journal tail, for evidence when a case fails.
  async nodeRedLog(lines = 80) {
    try {
      return await this.exec('journalctl -u node-red -n ' + Number(lines) + ' --no-pager 2>/dev/null || logread 2>/dev/null | tail -n ' + Number(lines));
    } catch (e) {
      return '(log unavailable: ' + e.message + ')';
    }
  }
}

module.exports = { Ssh };
