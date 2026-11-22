'use strict';
// Test-only osiLib binding for flow harnesses whose node calls
// osiLib.require('installation'). It resolves that name to the real profile
// copy of osi-installation-helper, the same module osi-lib loads on a gateway,
// so the harness exercises the shipped guard (gatewayWorkBlocked) instead of a
// stand-in. Other names fail the way an unregistered osi-lib name does, unless
// the caller supplies them in `extra`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');

function installationHelperPath(profile) {
  if (!profile.startsWith('bcm27xx_')) profile = 'bcm27xx_' + profile;
  return path.join(REPO, `conf/full_raspberrypi_${profile}/files/usr/share/node-red/osi-installation-helper`);
}

function installationOsiLib(profile = 'bcm27xx_bcm2712', extra = {}) {
  return {
    require(name) {
      if (name === 'installation') return { ok: true, value: require(installationHelperPath(profile)) };
      if (Object.prototype.hasOwnProperty.call(extra, name)) return { ok: true, value: extra[name] };
      return { ok: false, error: 'unknown osi-lib module: ' + name };
    },
  };
}

// Source of one async top-level function of the profile's installation helper.
// The stage handlers declare plain helper functions at column 0 inside their
// bodies, so a handler ends only at the next async function or the exports.
function helperFunctionSource(profile, name) {
  const source = fs.readFileSync(path.join(installationHelperPath(profile), 'index.js'), 'utf8');
  const start = source.search(new RegExp('^async function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, `${profile}: ${name} is defined in the installation helper`);
  const rest = source.slice(start + 1);
  const next = rest.search(/^async function |^module\.exports/m);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

// The account-link stages moved from their function nodes into the helper's
// accountLinkStage handlers; each node only delegates. This returns the source
// of the handler a node delegates to, after checking the delegation, so tests
// that inspect a stage read it where it now lives.
function accountStageSource(flows, profile, nodeId, stage, handler) {
  const node = flows.find((candidate) => candidate.id === nodeId);
  assert.ok(node, `${profile}: ${nodeId} exists`);
  assert.ok((node.libs || []).some((lib) => lib.var === 'osiLib' && lib.module === 'osi-lib'), `${profile}: ${nodeId} loads helpers through osi-lib`);
  assert.match(node.func, /osiLib\.require\('installation'\)/, `${profile}: ${nodeId} loads the installation helper`);
  assert.match(node.func, new RegExp("return load\\.value\\.accountLinkStage\\('" + stage + "',"), `${profile}: ${nodeId} delegates to the ${stage} stage`);
  assert.match(helperFunctionSource(profile, 'accountLinkStage'), new RegExp('\\b' + stage + ': ' + handler + '\\b'), `${profile}: the ${stage} stage is ${handler}`);
  return helperFunctionSource(profile, handler);
}

// The link request (al-link-build-req) and its capability list.
function linkBuilderSource(flows, profile = 'bcm27xx_bcm2712') {
  const body = accountStageSource(flows, profile, 'al-link-build-req', 'build', 'accountLink_build');
  assert.match(body, /msg\.payload = \{[^}]*\bsyncCapabilities \};/, `${profile}: the link request sends syncCapabilities`);
  return body;
}

// In-memory gateway IO for the account stages (global 'fs' and 'cp'): the
// account journal, queued restart requests and the UCI osi-server.cloud
// section live in maps, so a harness never touches the host's /data, /var/run
// or uci. One instance models one gateway between Node-RED restarts.
function accountGatewayIo() {
  const files = new Map();
  const config = new Map();
  const descriptors = new Map();
  let nextFd = 1;
  const missing = () => Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
  const io = {
    files,
    config,
    fs: {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => { if (!files.has(p)) throw missing(); return files.get(p); },
      readdirSync: (p) => [...files.keys()].filter((file) => path.dirname(file) === p).map((file) => path.basename(file)),
      openSync: (p, flags) => {
        if (flags === 'wx') { if (files.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); files.set(p, ''); }
        const fd = nextFd++;
        descriptors.set(fd, p);
        return fd;
      },
      writeFileSync: (p, data) => { files.set(typeof p === 'number' ? descriptors.get(p) : p, String(data)); },
      fsyncSync() {},
      closeSync: (fd) => { descriptors.delete(fd); },
      renameSync: (from, to) => { if (!files.has(from)) throw missing(); files.set(to, files.get(from)); files.delete(from); },
      unlinkSync: (p) => { if (!files.delete(p)) throw missing(); },
      mkdirSync() {},
    },
    cp: {
      execFileSync(command, args) {
        assert.equal(command, 'uci');
        if (args.includes('get')) {
          const key = args.at(-1);
          if (!config.has(key)) throw Object.assign(new Error('missing'), { status: 1 });
          return config.get(key);
        }
        if (args[0] === 'set') { const at = args[1].indexOf('='); config.set(args[1].slice(0, at), args[1].slice(at + 1)); }
        if (args.includes('delete')) config.delete(args.at(-1));
        return '';
      },
    },
  };
  return io;
}

module.exports = {
  installationOsiLib,
  installationHelperPath,
  helperFunctionSource,
  accountStageSource,
  linkBuilderSource,
  accountGatewayIo,
};
