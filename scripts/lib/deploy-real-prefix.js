'use strict';
// Runs deploy.sh's own main sequence, from its first line to a marker, against
// a fixture gateway, so a test sees what the deploy really does in order
// (#659 round 1: the extracted-function harnesses reimplement the sequence and
// cannot show an ordering defect). Every absolute gateway path in the script
// (/srv, /etc, /data, /usr, /var) is moved into the fixture; repository-relative
// fetch paths (".../files/usr/...") are left alone. Stand-ins on PATH:
// - curl: serves the fetch from this repository (react_gui.tar.gz from the
//   fixture), and cuts only live-asset transfers for source paths listed in
//   FAIL_LIVE_SOURCE;
// - uci: a small store under the fixture's etc/config, failing like uci on a
//   missing package or section;
// - ubus: Node-RED's service state from a file the init stand-in writes;
// - df: the capacity minus what the fixture tree uses, so staging and
//   removals change the free space;
// - logger, logread: a syslog file; the init stand-in logs the boot node's
//   completion line when it starts Node-RED, and wget answers /gui.
// The real sqlite3 and node are used.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SEED = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db');

function writeExec(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o755 });
}

function manifest(dir, skip = (rel) => rel.endsWith('-shm')) {
  const out = {};
  const walk = (at) => {
    for (const name of fs.readdirSync(at).sort()) {
      const file = path.join(at, name);
      const rel = path.relative(dir, file);
      if (skip(rel)) continue;
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) out[rel] = `link ${fs.readlinkSync(file)}`;
      else if (st.isDirectory()) { out[rel] = `dir ${(st.mode & 0o7777).toString(8)}`; walk(file); }
      else out[rel] = `file ${(st.mode & 0o7777).toString(8)} ${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

// layout: 'image' (a regular flows.json and a regular GUI directory, as an
// image-installed or sysupgraded gateway serves them), 'linked' (a served
// payload pair with its schema record, the swap helper already installed) or
// 'stock' (no flows and no GUI yet, as on a stock base before the first
// deploy).
function gateway({ layout = 'image', capacityKb = 4 * 1024 * 1024, database = true, osiServer = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-real-prefix-'));
  const gw = path.join(root, 'gw');
  const bin = path.join(root, 'bin');
  const g = { root, gw, bin, srv: path.join(gw, 'srv/node-red'), gui: path.join(gw, 'usr/lib/node-red/gui'), db: path.join(gw, 'data/db/farming.db'), backups: path.join(gw, 'data/backups/migrate') };
  for (const d of ['srv/node-red/payloads', 'etc/config', 'etc/init.d', 'etc/hotplug.d/ntp', 'usr/sbin', 'var/run', 'data/db']) fs.mkdirSync(path.join(gw, d), { recursive: true });
  writeExec(path.join(gw, 'etc/init.d/sysntpd'), '#!/bin/sh\nexit 0\n');
  writeExec(path.join(gw, 'usr/sbin/ntpd-hotplug'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(gw, 'etc/shadow'), 'root:$1$fixture$notarealhashxxxxxxxxx:1:0:99999:7:::\n');
  fs.writeFileSync(path.join(g.srv, 'settings.js'), '// settings before the deploy\n');
  if (osiServer) fs.writeFileSync(path.join(gw, 'etc/config/osi-server'), `${JSON.stringify({ cloud: { '.type': 'osi_server', enabled: '1', device_type: 'GATEWAY' } })}\n`);
  if (database) fs.copyFileSync(SEED, g.db);
  // Node-RED: the init stand-in records starts and stops in a state file.
  fs.writeFileSync(path.join(root, 'node-red.state'), '1');
  const syslog = path.join(root, 'syslog');
  fs.writeFileSync(syslog, '');
  writeExec(path.join(gw, 'etc/init.d/node-red'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(path.join(root, 'node-red.log'))}\ncase "$1" in stop) echo 0 > ${JSON.stringify(path.join(root, 'node-red.state'))} ;; start|restart) echo 1 > ${JSON.stringify(path.join(root, 'node-red.state'))}; echo "node-red: sync-init: schema init complete" >> ${JSON.stringify(syslog)} ;; esac\nexit 0\n`);
  if (layout === 'image') {
    fs.writeFileSync(path.join(g.srv, 'flows.json'), '[{"id":"served","type":"tab"}]\n');
    fs.mkdirSync(g.gui, { recursive: true });
    fs.writeFileSync(path.join(g.gui, 'index.html'), 'served GUI\n');
  } else if (layout === 'linked') {
    const swap = require(path.join(REPO, 'scripts/deploy-payload-swap.js'));
    const src = path.join(root, 'old-src');
    fs.mkdirSync(path.join(src, 'gui'), { recursive: true });
    fs.writeFileSync(path.join(src, 'flows.json'), '[{"id":"served","type":"tab"}]\n');
    fs.writeFileSync(path.join(src, 'gui/index.html'), 'served GUI\n');
    swap.stagePayload(g.srv, '20261101T000000Z', path.join(src, 'flows.json'), path.join(src, 'gui'));
    // A module set, as every deploy since #603 leaves one: capturing the
    // served modules then writes nothing.
    const mod = path.join(g.srv, 'payloads/20261101T000000Z/modules/osi-fixture-helper');
    fs.mkdirSync(mod, { recursive: true });
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name":"osi-fixture-helper","version":"1.0.0"}\n');
    swap.sealModules(g.srv, '20261101T000000Z');
    swap.flipTo(g.srv, '20261101T000000Z', g.gui);
    const schema = spawnSync('sqlite3', [g.db, "SELECT COALESCE(MAX(version),0) || '|' || group_concat(version || ':' || checksum, ',') FROM (SELECT version, checksum FROM schema_migrations WHERE status='applied' ORDER BY version)"], { encoding: 'utf8' }).stdout.trim();
    swap.writeCompatibility(g.srv, '20261101T000000Z', schema.split('|')[0], schema.slice(schema.indexOf('|') + 1));
    swap.markHealthy(g.srv, '20261101T000000Z');
    swap.writePayloadState(g.srv, '20261101T000000Z', 'healthy', 'fixture');
    fs.copyFileSync(path.join(REPO, 'scripts/deploy-payload-swap.js'), path.join(g.srv, '.payload-swap.js'));
    // #733 installs the atomic writer beside the swap helper, before any live
    // link changes; a gateway a 0.8.3 deploy left linked already has it.
    fs.mkdirSync(path.join(gw, 'usr/share/node-red'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-atomic-write.js'), path.join(gw, 'usr/share/node-red/osi-atomic-write.js'));
    fs.rmSync(src, { recursive: true, force: true });
  }
  // The GUI archive the deploy fetches.
  const guiSrc = path.join(root, 'gui-src');
  fs.mkdirSync(guiSrc);
  fs.writeFileSync(path.join(guiSrc, 'index.html'), 'new GUI\n');
  spawnSync('tar', ['czf', path.join(root, 'react_gui.tar.gz'), '-C', guiSrc, 'index.html']);
  writeExec(path.join(bin, 'curl'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const dest = a[a.indexOf('-fsSLo') + 1];
const rel = a[a.length - 1].replace(/^http:\\/\\/localhost:[0-9]+\\//, '');
const fail = (process.env.FAIL_LIVE_SOURCE || '').split(',');
if (path.basename(dest).startsWith('live-download.') && fail.includes(rel)) process.exit(22);
const src = rel === 'react_gui.tar.gz' ? ${JSON.stringify(path.join(root, 'react_gui.tar.gz'))} : path.join(${JSON.stringify(REPO)}, rel);
if (!fs.existsSync(src) || !fs.statSync(src).isFile()) process.exit(22);
fs.mkdirSync(path.dirname(dest), { recursive: true });
let body = fs.readFileSync(src);
if (rel.endsWith('/96_osi_server_config')) body = Buffer.from(String(body).split('/etc/config/').join(${JSON.stringify(`${gw}/etc/config/`)}));
fs.writeFileSync(dest, body);
`);
  writeExec(path.join(bin, 'uci'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
let a = process.argv.slice(2);
if (a[0] === '-q') a = a.slice(1);
const cfg = ${JSON.stringify(path.join(gw, 'etc/config'))};
const op = (cmd, arg = '') => {
  if (cmd === 'commit') { if (process.env.UCI_FAIL_COMMIT) { console.error('uci: I/O error'); process.exit(1); } return; }
  if (cmd === 'get' && arg === 'system.ntp.enabled') process.exit(1);
  const eq = arg.indexOf('='); const key = eq < 0 ? arg : arg.slice(0, eq); const value = eq < 0 ? '' : arg.slice(eq + 1);
  const [pkg, sec, opt] = key.split('.');
  const file = path.join(cfg, pkg);
  if (!fs.existsSync(file)) { if (cmd !== 'get') console.error('uci: Entry not found'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  if (cmd === 'get') { if (!data[sec] || (opt && data[sec][opt] === undefined)) process.exit(1); console.log(opt ? data[sec][opt] : data[sec]['.type']); return; }
  if (cmd === 'set') { if (!opt) data[sec] = { ...(data[sec] || {}), '.type': value }; else if (data[sec]) data[sec][opt] = value; else { console.error('uci: Entry not found'); process.exit(1); } }
  else if (cmd === 'delete') { if (!data[sec]) process.exit(1); if (opt) delete data[sec][opt]; else delete data[sec]; }
  else process.exit(2);
  fs.writeFileSync(file, JSON.stringify(data) + '\\n');
};
if (a[0] === 'batch') { for (const line of fs.readFileSync(0, 'utf8').split('\\n')) { const w = line.trim().split(/\\s+/); if (w[0]) op(w[0], (w[1] || '').replace(/^'|'$/g, '')); } }
else op(a[0], a[1]);
`);
  writeExec(path.join(bin, 'ubus'), `#!/bin/sh\nif [ "$(cat ${JSON.stringify(path.join(root, 'node-red.state'))})" = 1 ]; then echo '{"node-red":{"instances":{"i":{"running":true}}}}'; else echo '{}'; fi\n`);
  writeExec(path.join(bin, 'logread'), `#!/bin/sh\ncat ${JSON.stringify(syslog)}\n`);
  writeExec(path.join(bin, 'logger'), `#!/bin/sh\n[ "$1" = -t ] && shift 2\necho "$*" >> ${JSON.stringify(syslog)}\n`);
  writeExec(path.join(bin, 'wget'), '#!/bin/sh\nexit 0\n');
  writeExec(path.join(bin, 'df'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
let used = 0;
const walk = (p) => { let st; try { st = fs.lstatSync(p); } catch { return; } if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n)); else if (!st.isSymbolicLink()) used += st.size; };
walk(${JSON.stringify(gw)});
const cap = Number(fs.readFileSync(${JSON.stringify(path.join(root, 'capacity-kb'))}, 'utf8'));
console.log('Filesystem 1K-blocks Used Available Use% Mounted on');
console.log('/dev/fixture ' + cap + ' ' + Math.ceil(used / 1024) + ' ' + Math.max(0, cap - Math.ceil(used / 1024)) + ' 1% /');
`);
  fs.writeFileSync(path.join(root, 'capacity-kb'), String(capacityKb));
  g.setCapacityKb = (kb) => fs.writeFileSync(path.join(root, 'capacity-kb'), String(kb));
  g.usedKb = () => {
    let used = 0;
    const walk = (p) => { const st = fs.lstatSync(p); if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n)); else if (!st.isSymbolicLink()) used += st.size; };
    walk(gw);
    return Math.ceil(used / 1024);
  };
  g.manifest = () => manifest(gw);
  g.cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return g;
}

// deploy.sh from its first line to <marker> (exclusive), then <tail>.
function runPrefix(g, marker, tail = '', env = {}) {
  const deploy = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');
  const at = deploy.indexOf(marker);
  if (at < 0) throw new Error(`deploy.sh marker missing: ${marker}`);
  let script = `${deploy.slice(0, at)}\n${tail}\n`;
  for (const p of ['/srv', '/etc', '/data', '/usr', '/var']) {
    script = script.replace(new RegExp(`(?<!files)${p.replace('/', '\\/')}(?=/)`, 'g'), `${g.gw}${p}`);
  }
  script = script.split('/tmp/osi-os-deploy.').join(`${g.root}/tmp-deploy.`);
  const file = path.join(g.root, `prefix-${Date.now()}.sh`);
  fs.writeFileSync(file, script);
  // DEPLOY_STAMP has one-second resolution: two attempts must not share it.
  spawnSync('sleep', ['1.1']);
  return spawnSync('sh', [file], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${g.bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, ...env },
  });
}

module.exports = { gateway, runPrefix, manifest, REPO };
