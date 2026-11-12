'use strict';

// The deploy state table (issue #466, PR #618 amendment 2; council #636).
// Every live state a gateway can be in when deploy.sh starts, built with the
// swap helper's own functions where a deploy makes it and with plain file
// operations where a power loss, a sysupgrade, an older deploy.sh or an
// operator makes it. scripts/deploy-payload-swap.test.js checks each row's
// verdict; scripts/deploy-payload-kill-matrix.test.js kills a deploy from
// each row after every filesystem change.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const swap = require('../deploy-payload-swap');

const { stagePayload, flipTo, currentStamp, captureExisting, legacyCaptureStamp, discardPayload } = swap;

// A /srv/node-red stand-in with the entries deploy.sh keeps outside payloads.
function tableRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-node-red-table-'));
  fs.mkdirSync(path.join(root, 'payloads'));
  writeModule(path.join(root, 'osi-command-ledger'), 'ledger-live');
  fs.mkdirSync(path.join(root, 'osi-watermark-binding'));
  fs.writeFileSync(path.join(root, 'osi-watermark-binding', 'canonicalization.js'), "module.exports = 'binding-live';\n");
  fs.mkdirSync(path.join(root, 'codecs'));
  fs.writeFileSync(path.join(root, 'codecs', 'decoder.js'), '// live codec\n');
  fs.writeFileSync(path.join(root, 'edge-channels.json'), '{"channels":"live"}\n');
  return root;
}

function writeModule(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), version: '1.0.0', main: 'index.js' }) + '\n');
  fs.writeFileSync(path.join(dir, 'index.js'), `exports.marker = ${JSON.stringify(marker)};\n`);
}

function fakeFlowsSrcAt(root, marker) {
  const src = path.join(root, `flows-src-${marker}.json`);
  fs.writeFileSync(src, JSON.stringify([{ id: 'x', marker }]));
  return src;
}

function fakeGuiSrcAt(root, marker) {
  const gui = path.join(root, `gui-src-${marker}`);
  fs.rmSync(gui, { recursive: true, force: true });
  fs.mkdirSync(gui);
  fs.writeFileSync(path.join(gui, 'index.html'), `<title>${marker}</title>\n`);
  return gui;
}

// Stages flows, GUI and the named modules the way deploy.sh does, then seals.
function stageWithModules(root, stamp, modules) {
  stagePayload(root, stamp, fakeFlowsSrcAt(root, stamp), fakeGuiSrcAt(root, stamp));
  for (const name of Object.keys(modules)) writeModule(path.join(root, 'payloads', stamp, 'modules', name), `${name}@${stamp}`);
  return swap.sealModules(root, stamp);
}

function relink(root, name, target) {
  fs.rmSync(path.join(root, name), { recursive: true, force: true });
  fs.symlinkSync(target, path.join(root, name));
}

function staleMarker(marker, stamp) {
  fs.writeFileSync(marker, JSON.stringify({ format: 1, stamp, flows_path: 'x', gui_path: 'y', flows_sha256: '0', gui_sha256: '0' }) + '\n');
}

// One named case per row (S1-S35) of the table in the PR description. Each
// case builds the live state with the swap helper's own functions where a
// deploy makes it, and with plain file operations where a power loss, a
// sysupgrade, an older deploy.sh or an operator makes it, then checks the
// verdict. A change that flips any verdict fails the case named after its row.
const TABLE_MODULES = ['osi-a', 'osi-b'];

function tableGateway(root) {
  return {
    root,
    guiRoot: path.join(root, 'gui'),
    flowsPath: path.join(root, 'flows.json'),
    marker: path.join(root, 'payloads', '.legacy-capture.json'),
  };
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function treeText(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const child = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) return `${entry.name}->${fs.readlinkSync(child)}`;
      if (entry.isDirectory()) return `${entry.name}/{${treeText(child)}}`;
      return `${entry.name}=${fs.readFileSync(child, 'utf8')}`;
    })
    .join(',');
}

// flows.json, the GUI and every /srv/node-red/osi-* entry, as link text or
// content: the preflight must leave all of them as they are.
function liveSnapshot(g) {
  const describe = (file) => {
    const stat = lstatOrNull(file);
    if (!stat) return 'absent';
    if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`;
    if (stat.isDirectory()) return `dir:${treeText(file)}`;
    return `file:${fs.readFileSync(file, 'utf8')}`;
  };
  const out = { 'flows.json': describe(g.flowsPath), gui: describe(g.guiRoot) };
  for (const entry of fs.readdirSync(g.root).sort()) {
    if (entry.startsWith('osi-')) out[entry] = describe(path.join(g.root, entry));
  }
  return out;
}

function writeFlows(g, marker) {
  fs.writeFileSync(g.flowsPath, JSON.stringify([{ id: marker }]) + '\n');
}

// A fresh image, or a gateway the payload layout has not reached: regular
// flows and GUI, helper modules as real directories with the image's bytes.
function freshImage(g, image = 'image') {
  writeFlows(g, `flows@${image}`);
  writeModule(g.guiRoot, `gui@${image}`);
  for (const name of TABLE_MODULES) writeModule(path.join(g.root, name), `${name}@${image}`);
}

// A sysupgrade keeps /srv and puts the image GUI where the GUI link was. The
// image seed copies its helpers over real directories; the seed from v0.8.2 on
// leaves module links alone, older seeds replace them too.
function sysupgrade(g, image, { oldSeed = false } = {}) {
  fs.rmSync(g.guiRoot, { recursive: true, force: true });
  writeModule(g.guiRoot, `gui@${image}`);
  for (const name of TABLE_MODULES) {
    const live = path.join(g.root, name);
    const stat = lstatOrNull(live);
    if (stat && stat.isSymbolicLink() && !oldSeed) continue;
    fs.rmSync(live, { recursive: true, force: true });
    writeModule(live, `${name}@${image}`);
  }
}

// A v0.8.0 or v0.8.1 deploy: flows and GUI in one payload without
// modules.json; the helper modules stay real directories.
function pairDeploy(g, stamp) {
  stagePayload(g.root, stamp, fakeFlowsSrcAt(g.root, stamp), fakeGuiSrcAt(g.root, stamp));
  // Their flipTo() linked flows and GUI straight into the payload.
  relink(g.root, 'flows.json', path.join('payloads', stamp, 'flows.json'));
  fs.rmSync(g.guiRoot, { recursive: true, force: true });
  fs.symlinkSync(path.relative(path.dirname(g.guiRoot), path.join(g.root, 'payloads', stamp, 'gui')), g.guiRoot);
}

// A committed v0.8.2 deploy: flows, GUI and every helper module linked
// straight into one sealed payload.
function v082Deploy(g, stamp) {
  stageWithModules(g.root, stamp, { 'osi-a': '', 'osi-b': '' });
  cutFlip(g, stamp, 2 + TABLE_MODULES.length);
}

// A v0.7.0 deploy: a flows-only payload; the GUI and the helper modules are
// written in place, through a GUI or module link where there is one.
function flowsOnlyDeploy(g, stamp) {
  stagePayload(g.root, stamp, fakeFlowsSrcAt(g.root, stamp));
  relink(g.root, 'flows.json', path.join('payloads', stamp, 'flows.json'));
  fs.writeFileSync(path.join(g.guiRoot, 'index.html'), `<title>${stamp}</title>\n`);
  for (const name of TABLE_MODULES) {
    fs.writeFileSync(path.join(g.root, name, 'index.js'), `exports.marker = ${JSON.stringify(`${name}@${stamp}`)};\n`);
  }
}

// A deploy by this deploy.sh that committed: helper modules sealed in the
// payload, and flows, GUI and modules switched together.
function moduleDeploy(g, stamp) {
  stageWithModules(g.root, stamp, { 'osi-a': '', 'osi-b': '' });
  flipTo(g.root, stamp, g.guiRoot);
}

// A deploy that failed before Node-RED stopped: what deploy.sh does up to the
// module staging block, then the exit handler's discardPayload. No live file
// changes; the bookkeeping stays: a capture and its marker when flows and GUI
// were not one payload, and captured entries in the previous payload's
// modules.json. Returns the previous payload.
function failedBeforeStop(g, stamp) {
  let prev = currentStamp(g.root);
  if (!prev || prev !== swap.guiStamp(g.root, g.guiRoot)) {
    prev = legacyCaptureStamp(g.root, g.flowsPath, g.guiRoot);
    if (!prev) {
      prev = `${stamp}-previous`;
      captureExisting(g.root, prev, g.flowsPath, g.guiRoot);
    }
  }
  stageWithModules(g.root, stamp, { 'osi-a': '', 'osi-b': '', 'osi-c': '' });
  swap.captureModules(g.root, prev, stamp);
  swap.linkNewModules(g.root, stamp, prev);
  discardPayload(g.root, stamp);
  return prev;
}

function capturedEntries(g, stamp) {
  return Object.keys(JSON.parse(fs.readFileSync(path.join(g.root, 'payloads', stamp, 'modules.json'), 'utf8')).captured).sort();
}

// Power lost inside flipTo(stamp) after `steps` links moved: flows first, then
// the GUI, then each module of the payload's modules.json in order.
function cutFlip(g, stamp, steps) {
  const manifest = JSON.parse(fs.readFileSync(path.join(g.root, 'payloads', stamp, 'modules.json'), 'utf8'));
  const order = [
    ['flows.json', path.join('payloads', stamp, 'flows.json')],
    ['gui', path.join('payloads', stamp, 'gui')],
    ...manifest.modules.map((name) => [name, path.join('payloads', stamp, 'modules', name)]),
  ];
  for (const [name, target] of order.slice(0, steps)) relink(g.root, name, target);
}

function prune(g, stamp) {
  fs.rmSync(path.join(g.root, 'payloads', stamp), { recursive: true, force: true });
}

const HALF = (stamp, modules) => new RegExp(`the live flows point into payloads/${stamp}, but its helper modules ${modules} are not linked into it; refusing to capture a half-switched state`);

const STATE_TABLE = [
  // The capture block does not run, so the preflight leaves everything alone.
  { row: 'S1', verdict: 'SKIP', name: 'flows.json missing: a restore cut between removing the flows link and renaming the file back', builds: [(g) => {
    freshImage(g);
    staleMarker(g.marker, 'gone-previous');
    fs.renameSync(g.flowsPath, `${g.flowsPath}.osi-old-1-1`);
  }] },
  { row: 'S2', verdict: 'SKIP', name: 'flows.json links into a payload that is gone (removed by hand)', builds: [(g) => {
    freshImage(g);
    moduleDeploy(g, 'deployed');
    relink(g.root, 'flows.json', path.join('payloads', 'gone', 'flows.json'));
  }] },
  { row: 'S3', verdict: 'SKIP', name: 'the GUI links into a payload a v0.7.0 deploy.sh pruned after a pair deploy', builds: [(g) => {
    freshImage(g);
    pairDeploy(g, 'p081');
    flowsOnlyDeploy(g, 'o070');
    prune(g, 'p081');
  }] },
  // Flows and GUI share a payload: it is the rollback target, no capture.
  { row: 'S4', verdict: 'PAYLOAD', stale: true, name: 'a committed deploy: flows, GUI and modules in one payload', builds: [(g) => {
    freshImage(g);
    moduleDeploy(g, 'deployed');
  }] },
  { row: 'S5', verdict: 'PAYLOAD', name: 'a v0.8.1 gateway meets this deploy.sh: flows and GUI in a payload without modules.json, real helper directories', builds: [(g) => {
    freshImage(g);
    pairDeploy(g, 'p081');
  }] },
  { row: 'S6', verdict: 'PAYLOAD', name: 'the v0.8.1 gateway after a deploy failed before the stop: its payload has captured entries', builds: [(g) => {
    freshImage(g);
    pairDeploy(g, 'p081');
    failedBeforeStop(g, 'early');
    assert.deepEqual(capturedEntries(g, 'p081'), TABLE_MODULES);
  }] },
  { row: 'S7', verdict: 'PAYLOAD', name: 'a switch cut after the GUI: modules partly switched, the new payload is a full set (limit M6)', builds: [(g) => {
    freshImage(g);
    pairDeploy(g, 'p081');
    stageWithModules(g.root, 'cut', { 'osi-a': '', 'osi-b': '' });
    cutFlip(g, 'cut', 3);
  }] },
  { row: 'S8', verdict: 'PAYLOAD', name: 'the previous payload restarted into a legacy capture after a failure behind the stop; the marker stays', builds: [(g) => {
    freshImage(g);
    flipTo(g.root, failedBeforeStop(g, 'a'), g.guiRoot);
  }] },
  // A regular flows.json: no switch is under way.
  { row: 'S9', verdict: 'RECAPTURE', name: 'a fresh image or a gateway the payload layout has not reached', builds: [(g) => {
    freshImage(g);
  }] },
  { row: 'S10', verdict: 'RECAPTURE', name: 'a regular flows.json beside a GUI link: flows replaced by hand after a committed deploy', builds: [(g) => {
    freshImage(g);
    moduleDeploy(g, 'deployed');
    fs.rmSync(g.flowsPath);
    writeFlows(g, 'by-hand');
  }] },
  { row: 'S11', verdict: 'REUSE', name: 'a deploy failed before the stop on regular files; the retry finds its capture unchanged', builds: [(g) => {
    freshImage(g);
    failedBeforeStop(g, 'a');
  }] },
  { row: 'S12', verdict: 'REUSE', name: 'the same after a sysupgrade with the same image', builds: [(g) => {
    freshImage(g, 'image');
    failedBeforeStop(g, 'a');
    sysupgrade(g, 'image');
  }] },
  { row: 'S13', verdict: 'REFUSE', match: /refusing to recapture changed legacy files after a prior attempt/, name: 'the same after a sysupgrade with another image or a hand edit: the capture exists, the live files changed (kept, #466)', builds: [(g) => {
    freshImage(g, 'image');
    failedBeforeStop(g, 'a');
    sysupgrade(g, 'image2');
  }, (g) => {
    freshImage(g);
    failedBeforeStop(g, 'a');
    fs.appendFileSync(g.flowsPath, 'edited\n');
  }] },
  { row: 'S14', verdict: 'RECAPTURE', name: 'a marker whose capture was pruned by a deploy.sh that does not know it, or removed by hand', builds: [(g) => {
    freshImage(g);
    failedBeforeStop(g, 'a');
    prune(g, 'a-previous');
  }] },
  { row: 'S15', verdict: 'REFUSE', match: /no deploy attempt can be read from it/, name: 'a stale marker that names no -previous capture', builds: [(g) => {
    freshImage(g);
    staleMarker(g.marker, 'handmade');
  }] },
  { row: 'S16', verdict: 'REFUSE', match: /legacy evidence is unreadable|refusing to recapture changed legacy files after a prior attempt/, name: 'an unreadable or malformed marker', builds: [(g) => {
    freshImage(g);
    fs.writeFileSync(g.marker, 'not json\n');
  }, (g) => {
    freshImage(g);
    staleMarker(g.marker, '../outside-previous');
  }] },
  { row: 'S17', verdict: 'REFUSE', match: /the live GUI point into payloads\/a from the deploy that wrote it; refusing to capture a half-switched state/, name: 'a stale marker while the GUI links into the payload of the deploy that wrote it', builds: [(g) => {
    freshImage(g);
    captureExisting(g.root, 'a-previous', g.flowsPath, g.guiRoot);
    stageWithModules(g.root, 'a', { 'osi-a': '', 'osi-b': '' });
    relink(g.root, 'gui', path.join('payloads', 'a', 'gui'));
    prune(g, 'a-previous');
  }] },
  // flows.json links into one payload and the GUI into another.
  { row: 'S18', verdict: 'REFUSE', stale: true, match: /the live flows point into payloads\/cut but the GUI into payloads\/deployed; refusing to capture a half-switched state/, name: 'flows and GUI in different payloads, the flows payload carries a GUI: a pair switch cut between flows and GUI', builds: [(g) => {
    freshImage(g);
    moduleDeploy(g, 'deployed');
    stageWithModules(g.root, 'cut', { 'osi-a': '', 'osi-b': '' });
    cutFlip(g, 'cut', 1);
  }] },
  { row: 'S19', verdict: 'RECAPTURE', stale: true, name: 'flows in a flows-only payload beside a GUI link: a v0.7.0 deploy.sh ran after a pair deploy', builds: [(g) => {
    freshImage(g);
    pairDeploy(g, 'p081');
    flowsOnlyDeploy(g, 'o070');
  }, (g) => {
    freshImage(g);
    moduleDeploy(g, 'deployed');
    flowsOnlyDeploy(g, 'o070');
  }] },
  // flows.json links into a payload beside a GUI directory: the modules decide.
  { row: 'S20', verdict: 'RECAPTURE', stale: true, name: 'a payload without modules.json: a v0.8.1 gateway after a sysupgrade', builds: [(g) => {
    freshImage(g, 'image');
    pairDeploy(g, 'p081');
    sysupgrade(g, 'image');
  }] },
  { row: 'S21', verdict: 'RECAPTURE', stale: true, name: 'a v0.7.0 gateway: flows-only payload, GUI and helpers written in place, also with the #466 field marker', builds: [(g) => {
    freshImage(g);
    flowsOnlyDeploy(g, 'o070');
  }, (g) => {
    freshImage(g);
    failedBeforeStop(g, 'a');
    flowsOnlyDeploy(g, 'o070');
    prune(g, 'a-previous');
  }] },
  { row: 'S22', verdict: 'RECAPTURE', stale: true, name: 'every module linked into the sealed flows payload beside the image GUI: a committed deploy, or a full switch before its self-check (M6), then a sysupgrade', builds: [(g) => {
    freshImage(g);
    moduleDeploy(g, 'deployed');
    sysupgrade(g, 'image2');
  }] },
  { row: 'S23', verdict: 'RECAPTURE', stale: true, name: 'real helper directories with recorded digests that still match: v0.8.1, a deploy failed before the stop, same-image sysupgrade (re-review)', builds: [(g) => {
    freshImage(g, 'image');
    pairDeploy(g, 'p081');
    failedBeforeStop(g, 'early');
    assert.deepEqual(capturedEntries(g, 'p081'), TABLE_MODULES);
    sysupgrade(g, 'image');
  }] },
  { row: 'S24', verdict: 'RECAPTURE', stale: true, name: 'the same with another image or a hand-edited helper: the directories no longer match their digests', builds: [(g) => {
    freshImage(g, 'image');
    pairDeploy(g, 'p081');
    failedBeforeStop(g, 'early');
    sysupgrade(g, 'image2');
  }, (g) => {
    freshImage(g, 'image');
    pairDeploy(g, 'p081');
    failedBeforeStop(g, 'early');
    sysupgrade(g, 'image');
    fs.appendFileSync(path.join(g.root, 'osi-a', 'index.js'), '// edited on the gateway\n');
  }] },
  { row: 'S25', verdict: 'RECAPTURE', stale: true, name: 'helpers partly linked into a payload with recorded digests, partly real: its restart cut during the module switch, then a sysupgrade', builds: [(g) => {
    freshImage(g, 'image');
    pairDeploy(g, 'p081');
    failedBeforeStop(g, 'early');
    cutFlip(g, 'p081', 3);
    sysupgrade(g, 'image2');
  }] },
  { row: 'S26', verdict: 'REFUSE', stale: true, match: HALF('(?:cut|deployed)', 'osi-a, osi-b'), name: 'a real helper directory where the flows payload sealed its own copy: a switch from real directories cut after the GUI, or a sysupgrade with a v0.8.1 or older image', builds: [(g) => {
    freshImage(g, 'image');
    pairDeploy(g, 'p081');
    stageWithModules(g.root, 'cut', { 'osi-a': '', 'osi-b': '' });
    cutFlip(g, 'cut', 2);
    sysupgrade(g, 'image');
  }, (g) => {
    freshImage(g, 'image');
    moduleDeploy(g, 'deployed');
    sysupgrade(g, 'image', { oldSeed: true });
  }] },
  { row: 'S27', verdict: 'REFUSE', stale: true, match: /the live flows point into payloads\/(cut|p081), but its helper modules osi-a, osi-b are not linked into it/, name: 'a helper links into another payload: a switch cut after the GUI, or a restart of a payload with recorded digests cut the same way, then a sysupgrade', builds: [(g) => {
    freshImage(g);
    moduleDeploy(g, 'deployed');
    stageWithModules(g.root, 'cut', { 'osi-a': '', 'osi-b': '' });
    cutFlip(g, 'cut', 2);
    sysupgrade(g, 'image');
  }, (g) => {
    freshImage(g);
    pairDeploy(g, 'p081');
    failedBeforeStop(g, 'early');
    moduleDeploy(g, 'deployed');
    cutFlip(g, 'p081', 2);
    sysupgrade(g, 'image');
  }] },
  { row: 'S28', verdict: 'REFUSE', stale: true, match: /the live flows point into payloads\/(deployed|p081), but its helper modules osi-a are not linked into it/, name: 'a listed helper is missing or its link dangles (removed by hand)', builds: [(g) => {
    freshImage(g);
    moduleDeploy(g, 'deployed');
    sysupgrade(g, 'image2');
    prune(g, path.join('deployed', 'modules', 'osi-a'));
  }, (g) => {
    freshImage(g);
    moduleDeploy(g, 'deployed');
    sysupgrade(g, 'image2');
    fs.rmSync(path.join(g.root, 'osi-a'));
  }, (g) => {
    freshImage(g, 'image');
    pairDeploy(g, 'p081');
    failedBeforeStop(g, 'early');
    sysupgrade(g, 'image');
    fs.rmSync(path.join(g.root, 'osi-a'), { recursive: true, force: true });
  }] },
  { row: 'S29', verdict: 'REFUSE', stale: true, match: /module manifest (unreadable|malformed)/, name: 'the flows payload modules.json is unreadable or malformed', builds: [(g) => {
    freshImage(g);
    moduleDeploy(g, 'deployed');
    sysupgrade(g, 'image');
    fs.writeFileSync(path.join(g.root, 'payloads', 'deployed', 'modules.json'), 'not json\n');
  }, (g) => {
    freshImage(g);
    moduleDeploy(g, 'deployed');
    sysupgrade(g, 'image');
    fs.writeFileSync(path.join(g.root, 'payloads', 'deployed', 'modules.json'), '{"format":1,"modules":"osi-a"}\n');
  }] },
  // A marker beside flows.json linked into a payload.
  { row: 'S30', verdict: 'REFUSE', match: /refusing to recapture changed legacy files after a prior attempt/, name: 'a marker whose capture exists while flows link into a later attempt: a retry cut during its switch', builds: [(g) => {
    freshImage(g);
    failedBeforeStop(g, 'a');
    stageWithModules(g.root, 'b', { 'osi-a': '', 'osi-b': '', 'osi-c': '' });
    swap.captureModules(g.root, 'a-previous', 'b');
    swap.linkNewModules(g.root, 'b', 'a-previous');
    cutFlip(g, 'b', 1);
  }] },
  { row: 'S31', verdict: 'REUSE', name: 'a marker whose capture the flows link into: the previous payload restarted into the capture, then a same-image sysupgrade', builds: [(g) => {
    freshImage(g, 'image');
    flipTo(g.root, failedBeforeStop(g, 'a'), g.guiRoot);
    sysupgrade(g, 'image');
  }] },
  { row: 'S32', verdict: 'REFUSE', match: /the live flows point into payloads\/a from the deploy that wrote it; refusing to capture a half-switched state/, name: 'a stale marker while flows link into the payload of the deploy that wrote it: switched everything, no commit, sysupgrade, capture pruned', builds: [(g) => {
    freshImage(g);
    captureExisting(g.root, 'a-previous', g.flowsPath, g.guiRoot);
    stageWithModules(g.root, 'a', { 'osi-a': '', 'osi-b': '' });
    swap.captureModules(g.root, 'a-previous', 'a');
    flipTo(g.root, 'a', g.guiRoot);
    sysupgrade(g, 'image2');
    prune(g, 'a-previous');
  }] },
  { row: 'S33', verdict: 'REFUSE', match: HALF('b', 'osi-a, osi-b'), name: 'a stale marker while flows link into a later attempt that switched only flows: the first review sequence', builds: [(g) => {
    freshImage(g);
    failedBeforeStop(g, 'a');
    stageWithModules(g.root, 'b', { 'osi-a': '', 'osi-b': '', 'osi-c': '' });
    swap.captureModules(g.root, 'a-previous', 'b');
    swap.linkNewModules(g.root, 'b', 'a-previous');
    cutFlip(g, 'b', 1);
    prune(g, 'a-previous');
  }] },
  // Operator and power-loss leftovers around the marker.
  { row: 'S34', verdict: 'RECAPTURE', name: 'power lost after a stale marker was moved aside: the rerun finds no marker', builds: [(g) => {
    freshImage(g);
    failedBeforeStop(g, 'a');
    prune(g, 'a-previous');
    fs.renameSync(g.marker, `${g.marker}.stale-1-1`);
  }] },
  { row: 'S35', verdict: 'RECAPTURE', name: 'the operator moved the marker by hand while its capture exists: decided as without a marker', builds: [(g) => {
    freshImage(g);
    failedBeforeStop(g, 'a');
    fs.renameSync(g.marker, `${g.marker}.moved-by-hand`);
  }] },
  // Council #636: states the field can be in that the table lacked.
  { row: 'S36', verdict: 'PAYLOAD', stale: true, name: 'a committed v0.8.2 deploy: flows, GUI and every helper linked straight into one payload', builds: [(g) => {
    freshImage(g);
    v082Deploy(g, 'p082');
  }] },
  { row: 'S37', verdict: 'RECAPTURE', stale: true, name: 'the same after a sysupgrade: helper links kept, the image GUI in place of the GUI link', builds: [(g) => {
    freshImage(g);
    v082Deploy(g, 'p082');
    sysupgrade(g, 'image2');
  }] },
  { row: 'S38', verdict: 'REFUSE', resume: true, match: /refusing to recapture changed legacy files after a prior attempt/, name: 'a v0.8.2 deploy over regular files killed after it moved the GUI directory aside (council check 7): the resume step moves it back, flows stay switched', builds: [(g) => {
    freshImage(g);
    captureExisting(g.root, 'a-previous', g.flowsPath, g.guiRoot);
    stageWithModules(g.root, 'a', { 'osi-a': '', 'osi-b': '' });
    swap.captureModules(g.root, 'a-previous', 'a');
    cutFlip(g, 'a', 1);
    fs.renameSync(g.guiRoot, `${g.guiRoot}.osi-old-1-1`);
  }] },
  { row: 'S39', verdict: 'PAYLOAD', resume: true, name: 'a v0.8.2 switch from real helper directories killed after it moved a helper aside: the resume step moves it back, flows and GUI stay switched', builds: [(g) => {
    freshImage(g);
    pairDeploy(g, 'p081');
    stageWithModules(g.root, 'cut', { 'osi-a': '', 'osi-b': '' });
    cutFlip(g, 'cut', 2);
    fs.renameSync(path.join(g.root, 'osi-a'), path.join(g.root, 'osi-a.osi-old-1-1'));
  }] },
  { row: 'S40', verdict: 'PAYLOAD', name: 'a gateway converted by the first version of the one-rename switch, whose link was payloads/.active', builds: [(g) => {
    freshImage(g);
    moduleDeploy(g, 'deployed');
    const payloads = path.join(g.root, 'payloads');
    fs.renameSync(path.join(payloads, 'active'), path.join(payloads, '.active'));
    for (const at of [g.flowsPath, g.guiRoot, ...TABLE_MODULES.map((name) => path.join(g.root, name))]) {
      const text = fs.readlinkSync(at).replace(/(^|\/)payloads\/active\//, '$1payloads/.active/');
      fs.rmSync(at);
      fs.symlinkSync(text, at);
    }
  }] },
];


module.exports = {
  TABLE_MODULES,
  STATE_TABLE,
  tableRoot,
  tableGateway,
  liveSnapshot,
  writeModule,
  stageWithModules,
  staleMarker,
  relink,
};
