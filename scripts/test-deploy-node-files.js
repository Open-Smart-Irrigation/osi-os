'use strict';
// F-7: deploy.sh installs the node files (usr/share/node-red/nodes/) outside the
// payload, so a damaged copy would stay. install_node_files() fetches both into
// a stage beside /srv/node-red/nodes, checks them against the SHA-256 pins in
// deploy.sh, and only then moves them into place. This runs that function, as
// deploy.sh has it, against a local server: an intact answer installs the
// files; a fetch cut short (HTTP 200, full length declared, the connection
// closed after the first line, which is valid JavaScript that does nothing) and
// a complete but different file both leave the copies already there untouched.
// After the cut-short fetch, Node-RED (the image's 3.1.15 from
// scripts/fixtures/release-smoke/node_modules) starts on what is left and the
// flows' handle is serialized. The pins must match the shipped files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
const REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/nodes/';
const FILES = ['osi-sqlite-serialize.js', 'osi-sqlite-serialize.html'];
const shipped = (name) => fs.readFileSync(path.join(ROOT, REL, name));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function fromDeploy(re, what) {
  const m = re.exec(DEPLOY);
  if (!m) throw new Error('deploy.sh: ' + what + ' not found');
  return m[0];
}
const fn = (name) => fromDeploy(new RegExp('^' + name + '\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n', 'm'), name + '()');
const pin = (name) => fromDeploy(new RegExp('^' + name + '="[0-9a-f]{64}"$', 'm'), name);

test('the SHA-256 pins in deploy.sh match the shipped node files', () => {
  assert.equal(pin('OSI_SQLITE_SERIALIZE_JS_SHA256'), `OSI_SQLITE_SERIALIZE_JS_SHA256="${sha256(shipped(FILES[0]))}"`);
  assert.equal(pin('OSI_SQLITE_SERIALIZE_HTML_SHA256'), `OSI_SQLITE_SERIALIZE_HTML_SHA256="${sha256(shipped(FILES[1]))}"`);
  assert.match(DEPLOY, /^install_node_files$/m, 'deploy.sh calls install_node_files');
});

// mode: 'intact' | 'truncated' (the .js cut after its first line) | 'wrong' (a complete, different .js)
async function serve(mode) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.slice(1));
    if (!rel.startsWith(REL) || !FILES.includes(path.basename(rel))) { res.writeHead(404); res.end(); return; }
    const body = shipped(path.basename(rel));
    const isJs = rel.endsWith('.js');
    if (isJs && mode === 'truncated') {
      res.writeHead(200, { 'Content-Length': String(body.length), Connection: 'close' });
      res.write(body.subarray(0, body.indexOf('\n') + 1), () => res.socket.destroy());
      return;
    }
    const out = isJs && mode === 'wrong' ? Buffer.from("'use strict';\nmodule.exports = function () {};\n") : body;
    res.writeHead(200, { 'Content-Length': String(out.length) });
    res.end(out);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

async function install(mode, dir) {
  const server = await serve(mode);
  const stageRoot = path.join(dir, 'srv');
  fs.mkdirSync(stageRoot, { recursive: true });
  const script = [
    'set -eu',
    `BASE=http://127.0.0.1:${server.address().port}`,
    `NODE_FILES_DIR='${path.join(dir, 'nodes')}'`,
    `NODE_FILES_STAGE_ROOT='${stageRoot}'`,
    'NODE_FILES_STAGE="$NODE_FILES_STAGE_ROOT/.osi-node-files-stage.$$"',
    pin('OSI_SQLITE_SERIALIZE_JS_SHA256'), pin('OSI_SQLITE_SERIALIZE_HTML_SHA256'),
    fn('fetch'), fn('fetch_required'), fn('file_sha256'), fn('install_node_files'),
    'install_node_files',
  ].join('\n');
  const r = await new Promise((resolve) => {
    const child = spawn('sh', ['-c', script], { env: { ...process.env, PATH: path.dirname(process.execPath) + ':' + process.env.PATH } });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
  server.close();
  return { ...r, stageLeft: fs.readdirSync(stageRoot).filter((n) => n.startsWith('.osi-node-files-stage.')) };
}

function withDir(fnBody) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-node-files-'));
    try { await fnBody(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}
function seedWorkingCopy(dir) {
  fs.mkdirSync(path.join(dir, 'nodes'), { recursive: true });
  for (const f of FILES) fs.writeFileSync(path.join(dir, 'nodes', f), shipped(f));
}
const installed = (dir) => FILES.map((f) => fs.readFileSync(path.join(dir, 'nodes', f)));

test('an intact fetch installs both files', withDir(async (dir) => {
  const r = await install('intact', dir);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(installed(dir), FILES.map(shipped));
  assert.deepEqual(r.stageLeft, []);
}));

test('a complete but different file is refused; the working copy stays', withDir(async (dir) => {
  seedWorkingCopy(dir);
  const r = await install('wrong', dir);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /did not arrive intact; .* is unchanged/);
  assert.deepEqual(installed(dir), FILES.map(shipped));
  assert.deepEqual(r.stageLeft, []);
}));

test('a fetch cut short keeps the working copy, and Node-RED then serializes the handle', withDir(async (dir) => {
  seedWorkingCopy(dir);
  const r = await install('truncated', dir);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /did not arrive intact; .* is unchanged/);
  assert.deepEqual(installed(dir), FILES.map(shipped), 'the working copy is byte-identical');
  assert.deepEqual(r.stageLeft, []);

  // Restart: Node-RED starts with the nodes/ directory the failed deploy left.
  const user = path.join(dir, 'userdir');
  fs.mkdirSync(user);
  fs.cpSync(path.join(dir, 'nodes'), path.join(user, 'nodes'), { recursive: true });
  const evidence = path.join(user, 'evidence.jsonl');
  fs.writeFileSync(path.join(user, 'nodes/zz-osi-test-evidence.js'), `module.exports = function (RED) {
  RED.events.on('flows:started', () => setImmediate(() => {
    const n = RED.nodes.getNode('cfg1');
    require('fs').appendFileSync(process.env.OSI_TEST_EVIDENCE, JSON.stringify({ marked: !!(n && n.db && n.db[Symbol.for('osi.flowsDbSerialized')]) }) + '\\n');
  }));
};
`);
  fs.writeFileSync(path.join(user, 'nodes/zz-osi-test-evidence.html'), '');
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  fs.writeFileSync(path.join(user, 'settings.js'), `module.exports = ${JSON.stringify({ uiPort: port, uiHost: '127.0.0.1', httpAdminRoot: false, httpNodeRoot: '/', flowFile: 'flows.json', credentialSecret: false, logging: { console: { level: 'info', metrics: false, audit: false } } })};`);
  fs.writeFileSync(path.join(user, 'flows.json'), JSON.stringify([
    { id: 't1', type: 'tab', label: 'test' },
    { id: 'cfg1', type: 'sqlitedb', db: path.join(user, 'test.db'), mode: 'RWC' },
    { id: 'h1', type: 'http in', z: 't1', url: '/probe', method: 'get', wires: [['q1']] },
    { id: 'q1', type: 'sqlite', z: 't1', mydb: 'cfg1', sqlquery: 'fixed', sql: 'SELECT 2 AS two', wires: [['r1']] },
    { id: 'r1', type: 'http response', z: 't1', wires: [] },
  ]));
  const log = fs.openSync(path.join(user, 'nr.log'), 'w');
  const redJs = path.join(ROOT, 'scripts/fixtures/release-smoke/node_modules/node-red/red.js');
  const child = spawn(process.execPath, [redJs, '-u', user, '-s', path.join(user, 'settings.js')], { cwd: user, env: { ...process.env, OSI_TEST_EVIDENCE: evidence }, stdio: ['ignore', log, log] });
  try {
    const probe = () => new Promise((resolve) => { http.get({ host: '127.0.0.1', port, path: '/probe', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve(0)); });
    const until = Date.now() + 30000;
    while (!(fs.existsSync(evidence) && (await probe()) === 200)) {
      if (Date.now() > until) throw new Error('Node-RED did not start: ' + fs.readFileSync(path.join(user, 'nr.log'), 'utf8').slice(-2000));
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(evidence, 'utf8').trim().split('\n')[0]), { marked: true });
    assert.doesNotMatch(fs.readFileSync(path.join(user, 'nr.log'), 'utf8'), /osi-sqlite-serialize/);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); }
  }
}));

test('the old direct write would have destroyed the working copy (control)', withDir(async (dir) => {
  seedWorkingCopy(dir);
  const server = await serve('truncated');
  const status = await new Promise((resolve) => spawn('curl', ['-fsSLo', path.join(dir, 'nodes', FILES[0]), `http://127.0.0.1:${server.address().port}/${REL}${FILES[0]}`]).on('exit', resolve));
  server.close();
  assert.notEqual(status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'nodes', FILES[0]), 'utf8'), "'use strict';\n");
}));
