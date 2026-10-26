#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.resolve(process.env.OSI_BOOTSTRAP_UNDER_TEST || path.join(ROOT, 'scripts/chirpstack-bootstrap.js'));
const DEPLOY = path.resolve(process.env.OSI_DEPLOY_UNDER_TEST || path.join(ROOT, 'deploy.sh'));
const CANONICAL = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js');
const MIRROR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js');
const INIT_A = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap');
const INIT_B = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap');
const NODE_RED_INIT = path.join(ROOT, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init');
const SETTINGS_JS = path.join(ROOT, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js');
const API_KEY = 'synthetic-issue-183-api-key';
const RUNTIME_BASE = '63c7a70f8f3b373f162b33b0669b0df89b3763fa';
const TEKTELIC_CODEC = path.resolve(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/tektelic_agriculture_decoder.js');
const REPO_CODEC_READ_ALLOWLIST = new Set([TEKTELIC_CODEC]);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-issue-183-'));
  const envFile = path.join(dir, '.chirpstack.env');
  return { dir, envFile, backup: envFile + '.pre-gen2', settingsJs: path.join(dir, 'settings.js'), flowsJson: path.join(dir, 'flows.json') };
}
function clean(fx) { fs.rmSync(fx.dir, { recursive: true, force: true }); }
function mode(file) { return fs.statSync(file).mode & 0o7777; }
function syntheticError(code) { const e = new Error('synthetic-secret-must-not-escape'); e.code = code || 'EIO'; return e; }

function helper(events) {
  let id = 2;
  const next = () => '00000000-0000-4000-8000-' + String(id++).padStart(12, '0');
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const profiles = [
    { id: '00000000-0000-4000-8000-000000000011', name: 'OSI KIWI Sensor', tenantId, runtime: 0, script: '', auto: false },
    { id: '00000000-0000-4000-8000-000000000012', name: 'OSI RAK Field Tester', tenantId, runtime: 0, script: '', auto: false },
    { id: '00000000-0000-4000-8000-000000000013', name: 'OSI CLOVER Sensor', tenantId, runtime: 2, script: 'function decodeUplink(input) { return input; }', auto: true }
  ];
  const view = p => ({
    getPayloadCodecRuntime: () => p.runtime, getPayloadCodecScript: () => p.script,
    getAutoDetectMeasurements: () => p.auto, getName: () => p.name,
    getDescription: () => p.description || '', getTenantId: () => p.tenantId,
    getUplinkInterval: () => p.uplinkInterval || 3600, getDeviceStatusReqInterval: () => p.deviceStatusReqInterval || 1
  });
  const client = {
    async listTenants() { return [{ id: tenantId, name: 'Open Smart Irrigation' }]; },
    async createTenant() { const value = next(); events.push(['createTenant']); return { getId: () => value }; },
    async listApplications() { return []; },
    async createApplication(x) { const value = next(); events.push(['createApplication', x.name]); return { getId: () => value }; },
    async listDeviceProfiles() { if (events.some(x => Array.isArray(x) && x[0] === 'fail-api')) throw new Error('synthetic soil RPC failure'); if (process.env.ISSUE183_SOIL_API_FAILURE === '1') throw new Error('synthetic soil API failure'); return profiles.map(x => ({ id: x.id, name: x.name })); },
    async getDeviceProfile(value) { const p = profiles.find(x => x.id === value); return p ? view(p) : null; },
    async createDeviceProfile(x) {
      const p = { id: next(), name: x.name, tenantId: x.tenantId, runtime: x.payloadCodecScript ? 2 : 0, script: x.payloadCodecScript || '', auto: Boolean(x.autoDetectMeasurements) };
      profiles.push(p); events.push(['createProfile', p.name]); return { getId: () => p.id };
    },
    async updateDeviceProfile(x) {
      const p = profiles.find(y => y.id === x.id);
      Object.assign(p, { runtime: 2, script: x.payloadCodecScript, auto: Boolean(x.autoDetectMeasurements) });
      events.push(['updateProfile', p.name]);
    },
    async getDevice() { return null; }, async setDeviceProfile() { return false; }
  };
  return { createClient() { events.push(['client']); return client; }, listItemToObject: x => x, normalizeDevEui: x => String(x).toUpperCase() };
}
function childProcess(events, options = {}) {
  const committed = new Map(Object.entries(options.uci || {}));
  const pending = new Map(committed);
  return {
    execSync(command) {
      if (/create-api-key/.test(command)) { events.push(['api-key']); return Buffer.from('id: synthetic\ntoken: ' + API_KEY + '\n'); }
      throw new Error('unexpected synthetic execSync');
    },
    execFileSync(file, args) {
      if (file !== 'uci') throw new Error('unexpected synthetic executable');
      if (args[0] === 'set') {
        const assignment = String(args[1] || ''); const equal = assignment.indexOf('=');
        if (equal <= 0) throw new Error('invalid synthetic UCI set');
        pending.set(assignment.slice(0, equal), assignment.slice(equal + 1));
        events.push(['uci-write', 'set', assignment]);
        return '';
      }
      if (args[0] === 'commit') {
        pending.forEach((value, key) => committed.set(key, value));
        events.push(['uci-write', 'commit', ...args.slice(1)]);
        return '';
      }
      if (args[0] === '-q' && args[1] === 'get') {
        events.push(['uci-read', ...args]);
        const value = committed.get(args[2]);
        if (value !== undefined) return value + '\n';
        const e = new Error('not configured'); e.status = 1; throw e;
      }
      throw new Error('unexpected synthetic UCI command');
    }
  };
}
function resolvedFsPath(file, base = fs) {
  if (typeof file === 'number') return base.readlinkSync('/proc/self/fd/' + file).replace(/ \(deleted\)$/, '');
  const value = Buffer.isBuffer(file) ? file.toString() : String(file);
  const match = value.match(/^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/);
  if (match) {
    const parent = base.readlinkSync('/proc/self/fd/' + match[1]).replace(/ \(deleted\)$/, '');
    return path.resolve(parent, match[2] || '');
  }
  return path.resolve(value);
}
function withinFixture(fx, candidate) {
  const relative = path.relative(fx.dir, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function isFixtureAncestor(fx, candidate) {
  const relative = path.relative(candidate, fx.dir);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function isStageEnvPath(file, envFile, base = fs) {
  const resolved = resolvedFsPath(file, base);
  return path.basename(resolved) === 'env' && path.basename(path.dirname(resolved)).startsWith('.' + path.basename(envFile) + '.tmp-');
}
function guardedProductFs(fx, base = fs) {
  const requireFixture = value => {
    const resolved = resolvedFsPath(value, base);
    assert.ok(withinFixture(fx, resolved), 'product filesystem effect escaped fixture: ' + resolved);
    return resolved;
  };
  const requireRead = value => {
    if (typeof value === 'number') return requireFixture(value);
    const raw = Buffer.isBuffer(value) ? value.toString() : String(value);
    if (raw === '/proc/self/fd') return raw;
    const resolved = resolvedFsPath(raw, base);
    assert.ok(withinFixture(fx, resolved) || isFixtureAncestor(fx, resolved) || REPO_CODEC_READ_ALLOWLIST.has(resolved), 'product read escaped fixture ancestry and codec allowlist: ' + resolved);
    return resolved;
  };
  const mutatingPathMethods = new Set(['appendFileSync','chmodSync','chownSync','copyFileSync','linkSync','mkdirSync','mkdtempSync','renameSync','rmSync','rmdirSync','symlinkSync','truncateSync','unlinkSync','writeFileSync']);
  const mutatingFdMethods = new Set(['appendFileSync','fchmodSync','fchownSync','fdatasyncSync','fsyncSync','ftruncateSync','futimesSync','writeFileSync','writeSync']);
  const procDescriptorPath = value => typeof value === 'string' && (/^\/proc\/self\/fd$/.test(value) || /^\/proc\/self\/fd\/\d+(?:\/.*)?$/.test(value));
  return new Proxy(base, { get(target, key) {
    const value = target[key];
    if (key === 'existsSync') return file => {
      if (file === '/usr/libexec/osi-gateway-identity.sh') return false;
      requireRead(file);
      return value.call(target, file);
    };
    if (key === 'readFileSync') return (file, ...args) => {
      requireRead(file);
      return value.call(target, file, ...args);
    };
    if (key === 'statSync' || key === 'lstatSync' || key === 'accessSync') return (file, ...args) => {
      if (procDescriptorPath(String(file))) return value.call(target, file, ...args);
      requireRead(file);
      return value.call(target, file, ...args);
    };
    if (key === 'readlinkSync') return (file, ...args) => {
      assert.ok(procDescriptorPath(String(file)), 'unexpected product readlink: ' + file);
      return value.call(target, file, ...args);
    };
    if (key === 'openSync') return (file, flags, ...args) => {
      const writeMask = target.constants.O_WRONLY | target.constants.O_RDWR | target.constants.O_CREAT | target.constants.O_TRUNC | target.constants.O_APPEND;
      if (typeof flags === 'number' && (flags & writeMask)) requireFixture(file);
      else if (file !== '/' && !procDescriptorPath(String(file))) requireRead(file);
      else if (typeof file === 'string' && file.startsWith('/proc/self/fd/')) resolvedFsPath(file, target);
      return value.call(target, file, flags, ...args);
    };
    if (mutatingPathMethods.has(key)) return (file, ...args) => {
      if (key === 'linkSync' || key === 'renameSync' || key === 'copyFileSync') requireFixture(args[0]);
      requireFixture(file);
      return value.call(target, file, ...args);
    };
    if (mutatingFdMethods.has(key)) return (fd, ...args) => {
      if (typeof fd === 'number') requireFixture(fd);
      else requireFixture(fd);
      return value.call(target, fd, ...args);
    };
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}
function hooks(fx, opts = {}) {
  const events = opts.events || [];
  if (opts.failApi) events.push(['fail-api']);
  const env = {
    ENV_FILE: fx.envFile, SETTINGS_JS: fx.settingsJs, FLOWS_JSON: fx.flowsJson, CHIRPSTACK_API_KEY: API_KEY,
    TEKTELIC_CODEC_PATH: TEKTELIC_CODEC,
    STREGA_CODEC_PATH: path.join(fx.dir, 'codecs/strega.js'), STREGA_GEN2_CODEC_PATH: path.join(fx.dir, 'codecs/strega-gen2.js'),
    LSN50_CODEC_PATH: path.join(fx.dir, 'codecs/lsn50.js'), S2120_CODEC_PATH: path.join(fx.dir, 'codecs/s2120.js'),
    LORAIN_CODEC_PATH: path.join(fx.dir, 'codecs/lorain.js'), UC512_CODEC_PATH: path.join(fx.dir, 'codecs/uc512.js'),
    SDI12_CODEC_PATH: path.join(fx.dir, 'codecs/sdi12.js'),
    ...opts.env
  };
  let source = fs.readFileSync(SOURCE, 'utf8').replace(/^#!.*\n/, '');
  const candidateExports = ['run','writeEnvFile','writeEnvFileAtomic','secureEnvFiles','readEnvFileForMutation','backupEnvFile','decodeEnvUtf8','publishEnvContent','CredentialEnvError','UsageError','CFG','parseEnvText'];
  const availableExports = candidateExports.filter(name => new RegExp('(?:function|class|const|let)\\s+' + name + '\\b').test(source));
  source = source.replace(/\nrun\(process\.argv\.slice\(2\)\)\.catch\([\s\S]*?\);\s*$/, '\nmodule.exports.__issue183 = {' + availableExports.join(',') + '};\n');
  const fakeProcess = { env, argv: ['node', SOURCE], platform: process.platform, getuid: () => opts.virtualRoot ? 0 : process.getuid(), geteuid: () => opts.virtualRoot ? 0 : process.geteuid(), exit: code => events.push(['exit', code]) };
  const fakeModule = { exports: {} };
  const fakeRequire = name => {
    if (name === 'fs') return guardedProductFs(fx, opts.fs || fs);
    if (name === 'path') return path;
    if (name === 'child_process') return childProcess(events, opts);
    if (typeof name === 'string' && name.endsWith('osi-chirpstack-helper')) return helper(events);
    return require(name);
  };
  fakeRequire.main = fakeModule;
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', 'console', source)(
    fakeRequire, fakeModule, fakeModule.exports, path.dirname(SOURCE), SOURCE, fakeProcess,
    opts.console || { log: (...x) => events.push(['log', ...x]), error: (...x) => events.push(['error', ...x]), warn: (...x) => events.push(['warn', ...x]) }
  );
  assert.ok(fakeModule.exports.__issue183, 'test-only hook extraction found the planned operations');
  return { api: fakeModule.exports.__issue183, events };
}
function noExternalPreload(fx) {
  const preload = path.join(fx.dir, 'deny-external.cjs');
  const trace = path.join(fx.dir, 'external-loads.log');
  const code = [
    "const Module=require('node:module');",
    "const path=require('node:path');",
    "const fs=require('node:fs');",
    "const allowed=new Set(Module.builtinModules);",
    "const target=path.resolve(process.env.OSI_GUARD_TARGET);",
    "const original=Module._load;",
    "Module._load=function(request,parent,isMain){",
    " if(parent && parent.filename && path.resolve(parent.filename)===target && !allowed.has(request) && !String(request).startsWith('node:')){",
    "  fs.appendFileSync(process.env.OSI_GUARD_TRACE,String(request)+'\\n');",
    "  throw new Error('external module denied by test preload');",
    " }",
    " return original.apply(this,arguments);",
    "};"
  ].join("\n");
  fs.writeFileSync(preload, code);
  return { preload, trace };
}

function credentialError(error) {
  assert.equal(error && error.name, 'CredentialEnvError');
  assert.equal(error.exitStatus, 74);
  assert.equal(error.message, 'Credential env-file operation failed');
  assert.doesNotMatch(JSON.stringify(error), /synthetic-secret|CHIRPSTACK_API_KEY=/);
  return true;
}
function cli(args, fx, options = {}) {
  const env = { PATH: '/usr/bin:/bin', ENV_FILE: fx.envFile, ...options.env };
  if (options.preload) env.NODE_OPTIONS = '--require ' + options.preload;
  return cp.spawnSync(process.execPath, [options.source || SOURCE, ...args], { encoding: 'utf8', env, timeout: options.timeout || 5000, maxBuffer: 2 * 1024 * 1024, uid: options.uid, gid: options.gid });
}

function publisherPreloadSource(fx, fault, operation, traceFile) {
  return [
    "'use strict';",
    "const nativeFs=require('node:fs'), path=require('node:path'), Module=require('node:module'), assert=require('node:assert/strict');",
    'const API_KEY=' + JSON.stringify(API_KEY) + ';',
    'const fixture={dir:' + JSON.stringify(fx.dir) + '};',
    'const SOURCE_PATH=' + JSON.stringify(fx.sourceFile || SOURCE) + ';',
    'const TARGET=' + JSON.stringify(fx.envFile) + ';',
    'const TRACE=' + JSON.stringify(traceFile) + ';',
    'const REPO_CODEC_READ_ALLOWLIST=new Set(' + JSON.stringify([...REPO_CODEC_READ_ALLOWLIST]) + ');',
    'const resolvedFsPath=' + resolvedFsPath.toString() + ';',
    'const withinFixture=' + withinFixture.toString() + ';',
    'const isFixtureAncestor=' + isFixtureAncestor.toString() + ';',
    'const guardedProductFs=' + guardedProductFs.toString() + ';',
    'const helperFactory=' + helper.toString() + ';',
    'const childProcessFactory=' + childProcess.toString() + ';',
    'const fault=' + JSON.stringify(fault || '') + ', operation=' + JSON.stringify(operation || '') + ';',
    "const activeOperation=process.argv.includes('--repair-soil-profiles')?'soil':process.argv.length===2?'full':'file-only';",
    "const virtualRoot=process.env.ISSUE183_VIRTUAL_ROOT==='1'; if(virtualRoot){process.geteuid=()=>0;process.getuid=()=>0;}",
    'const events=[]; let published=false, faultFired=false, closedOuter=false;',
    "const note=(kind, detail={})=>{events.push({kind,...detail});};",
    "const stageEnv=file=>{try{const resolved=resolvedFsPath(file,nativeFs);return path.basename(resolved)==='env'&&path.basename(path.dirname(resolved)).startsWith('.'+path.basename(TARGET)+'.tmp-');}catch{return false;}};",
    "const productFs=new Proxy(guardedProductFs(fixture,nativeFs),{get(target,key){const value=target[key];if(virtualRoot&&key==='fchownSync')return(fd,...args)=>{if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='fchown'&&stageEnv(fd)){faultFired=true;note('fault',{fault,phase:'stage',ownership:'virtual'});const e=new Error('synthetic stage chown');e.code='EPERM';throw e;}return undefined;};if(virtualRoot&&['statSync','lstatSync','fstatSync'].includes(key))return(...args)=>{const st=value.call(target,...args);st.uid=0;st.gid=0;return st;};",
    "if(key==='openSync')return(file,flags,...args)=>{if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='open'&&stageEnv(file)){faultFired=true;note('fault',{fault,phase:'stage'});const e=new Error('synthetic stage open');e.code='EIO';throw e;}return value.call(target,file,flags,...args);};",
    "if(key==='fchownSync')return(fd,...args)=>{if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='fchown'&&stageEnv(fd)){faultFired=true;note('fault',{fault,phase:'stage'});const e=new Error('synthetic stage chown');e.code='EPERM';throw e;}return value.call(target,fd,...args);};",
    "if(key==='fchmodSync')return(fd,...args)=>{if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='fchmod'&&stageEnv(fd)){faultFired=true;note('fault',{fault,phase:'stage'});const e=new Error('synthetic stage chmod');e.code='EIO';throw e;}return value.call(target,fd,...args);};",
    "if(key==='writeFileSync')return(file,data,...args)=>{if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='write'&&typeof file==='number'&&stageEnv(file)){faultFired=true;nativeFs.writeFileSync(file,Buffer.from(data).subarray(0,Math.max(1,Math.floor(Buffer.byteLength(data)/2))),...args);note('fault',{fault,phase:'stage'});const e=new Error('synthetic partial write');e.code='ENOSPC';throw e;}return value.call(target,file,data,...args);};",
    "if(key==='fsyncSync')return fd=>{if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='file-fsync'&&stageEnv(fd)){faultFired=true;note('fault',{fault,phase:'flush'});const e=new Error('synthetic file fsync');e.code='EIO';throw e;}if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='dir-fsync'&&published&&nativeFs.fstatSync(fd).isDirectory()&&path.resolve(nativeFs.readlinkSync('/proc/self/fd/'+fd))===path.dirname(TARGET)){faultFired=true;note('fault',{fault,phase:'flush'});const e=new Error('synthetic directory fsync');e.code='EIO';throw e;}return value.call(target,fd);};",
    "if(key==='renameSync')return(from,to)=>{if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&(fault==='rename'||fault==='pre-rename')&&stageEnv(from)){faultFired=true;note('fault',{fault,phase:'publish'});const e=new Error('synthetic rename');e.code='EIO';throw e;}const result=value.call(target,from,to);if(operation===process.env.ISSUE183_OPERATION){note('rename-observed',{from:String(from),resolved:resolvedFsPath(from,nativeFs),stage:stageEnv(from)});if(stageEnv(from))published=true;}return result;};",
    "if(key==='linkSync')return(from,to)=>{const dest=resolvedFsPath(to,nativeFs);if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='link'&&stageEnv(from)&&(dest===TARGET||dest===TARGET+'.pre-gen2')){faultFired=true;note('fault',{fault,phase:'publish'});const e=new Error('synthetic link');e.code='EEXIST';throw e;}const result=value.call(target,from,to);if(operation===process.env.ISSUE183_OPERATION){note('rename-observed',{from:String(from),resolved:resolvedFsPath(from,nativeFs),stage:stageEnv(from)});if(stageEnv(from))published=true;}return result;};",
    "if(key==='unlinkSync')return file=>{if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='private-unlink'&&published&&stageEnv(file)){faultFired=true;note('fault',{fault,phase:'cleanup'});const e=new Error('synthetic private unlink');e.code='EIO';throw e;}return value.call(target,file);};",
    "if(key==='readFileSync')return(file,...args)=>{if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='verify-read'&&published&&typeof file==='number'&&path.resolve(nativeFs.readlinkSync('/proc/self/fd/'+file))===TARGET){faultFired=true;note('fault',{fault,phase:'verify'});const e=new Error('synthetic verify read');e.code='EIO';throw e;}return value.call(target,file,...args);};",
    "if(key==='closeSync')return fd=>{const st=nativeFs.fstatSync(fd),name=nativeFs.readlinkSync('/proc/self/fd/'+fd).replace(/ \(deleted\)$/,'');if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='stage-close'&&st.isFile()&&stageEnv(fd)){faultFired=true;nativeFs.closeSync(fd);note('fault',{fault,phase:'cleanup'});const e=new Error('synthetic stage close');e.code='EIO';throw e;}if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='published-close'&&published&&st.isFile()&&path.resolve(name)===TARGET){faultFired=true;nativeFs.closeSync(fd);note('fault',{fault,phase:'cleanup'});const e=new Error('synthetic published close');e.code='EIO';throw e;}if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='outer-close'&&published&&!closedOuter&&st.isDirectory()&&path.resolve(name)===path.dirname(TARGET)){closedOuter=true;nativeFs.closeSync(fd);faultFired=true;note('fault',{fault,phase:'cleanup'});const e=new Error('synthetic outer close');e.code='EIO';throw e;}return value.call(target,fd);};",
    "if(key==='rmdirSync')return dir=>{if(operation===process.env.ISSUE183_OPERATION&&activeOperation===operation&&fault==='rmdir'&&path.basename(String(dir)).startsWith('.'+path.basename(TARGET)+'.tmp-')){faultFired=true;note('fault',{fault,phase:'cleanup'});const e=new Error('synthetic rmdir');e.code='EIO';throw e;}return value.call(target,dir);};",
    "return value;}});",
    "const fakeCp=childProcessFactory(events,{uci:JSON.parse(process.env.ISSUE183_UCI_STATE||'{}')});",
    "const originalLoad=Module._load;Module._load=function(request,parent,isMain){if(parent&&path.resolve(parent.filename||'')===SOURCE_PATH){if(request==='fs')return productFs;if(request==='child_process')return fakeCp;if(String(request).endsWith('osi-chirpstack-helper'))return helperFactory(events);}return originalLoad.apply(this,arguments);};",
    "process.on('exit',()=>{events.push({kind:'fault-summary',fault,operation,faultFired,published});nativeFs.appendFileSync(TRACE,JSON.stringify(events)+'\\n');});"
  ].join('\n');
}

function assertRootTap(output, expectedFailures = []) {
  const count = name => {
    const match = output.match(new RegExp('^# ' + name + ' (\\d+)\\s*$', 'm'));
    assert.ok(match, 'root TAP summary includes ' + name + ' count');
    return Number(match[1]);
  };
  assert.equal(count('tests') > 0, true, 'root TAP ran its named suite');
  assert.equal(count('fail'), expectedFailures.length, 'root TAP failure count matches the explicit expectation');
  const failedNames = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(failedNames, expectedFailures, 'root TAP has only the named behavioral failures');
  assert.equal(count('cancelled'), 0, 'root TAP has zero cancelled tests');
  assert.equal(count('skipped'), 0, 'root TAP has zero skipped tests');
  assert.doesNotMatch(output, /^\s*(?:ok|not ok)\s+\d+\b.*#\s*(?:SKIP|TODO|CANCELLED)\b/im, 'root TAP has no skip/cancel directives');
}

if (process.geteuid() !== 0) {
  test('issue 183 root qualification re-entry', t => {
    const cleanEnv = ['PATH=/usr/bin:/bin'];
    if (process.env.OSI_BOOTSTRAP_UNDER_TEST) cleanEnv.push('OSI_BOOTSTRAP_UNDER_TEST=' + process.env.OSI_BOOTSTRAP_UNDER_TEST);
    if (process.env.OSI_DEPLOY_UNDER_TEST) cleanEnv.push('OSI_DEPLOY_UNDER_TEST=' + process.env.OSI_DEPLOY_UNDER_TEST);
    if (process.env.OSI_BOOTSTRAP_B3 === '1') cleanEnv.push('OSI_BOOTSTRAP_B3=1');
    const result = cp.spawnSync('sudo', ['-n', 'env', '-i', ...cleanEnv, process.execPath, '--test', '--test-concurrency=1', path.resolve(__filename)], { encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
    t.diagnostic((result.stdout || '') + (result.stderr || ''));
    assert.equal(result.error && result.error.code, undefined, 'root child did not time out or fail to spawn');
    assert.equal(result.signal, null);
    const b3 = process.env.OSI_BOOTSTRAP_B3 === '1';
    const requiredNames = b3
      ? ['B3 expected failure: base writer creates permissive credentials', 'B3 expected failure: base writer retains permissive replacement']
      : ['T0 TAP oracle', 'T1 creation', 'T2 narrowing', 'T3 full merge', 'T4 soil repair', 'T5 raw backup', 'T6 hostile paths and CLI', 'T7 deploy routing', 'T8 failure preservation', 'T9 interruption', 'T10 mirrors and actual runtime consumers'];
    const expectedStatus = b3 ? 1 : 0;
    t.diagnostic('root child direct exit ' + result.status + '; expected ' + expectedStatus);
    assert.equal(result.status, expectedStatus);
    for (const name of requiredNames) assert.ok((result.stdout || '').includes(name));
    assertRootTap(result.stdout || '', b3 ? requiredNames : []);
  });
} else if (process.env.OSI_BOOTSTRAP_B3 === '1') {
  test('B3 expected failure: base writer creates permissive credentials', t => {
    const fx = fixture(); const old = process.umask(0o022);
    try {
      const api = hooks(fx).api;
      assert.equal(typeof api.writeEnvFile, 'function', 'base writer interface extracted');
      api.writeEnvFile({ SYNTHETIC: 'base-create' });
      const st = fs.statSync(fx.envFile);
      const snapshot = fs.readFileSync(fx.envFile); const observed = { base: RUNTIME_BASE, source: SOURCE, sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex'), snapshotHex: snapshot.toString('hex'), bytes: snapshot.length, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777, directStatus: 0 };
      t.diagnostic('B3 A1 old-source snapshot ' + JSON.stringify(observed));
      assert.equal(observed.mode, 0o600, 'security contract: base creation must be restrictive');
    } finally { process.umask(old); clean(fx); }
  });
  test('B3 expected failure: base writer retains permissive replacement', t => {
    const fx = fixture(); const old = process.umask(0o022);
    try {
      fs.writeFileSync(fx.envFile, 'OLD=base\n', { mode: 0o644 }); fs.chmodSync(fx.envFile, 0o644);
      hooks(fx).api.writeEnvFile({ SYNTHETIC: 'base-replace' });
      const st = fs.statSync(fx.envFile);
      const snapshot = fs.readFileSync(fx.envFile); const observed = { base: RUNTIME_BASE, source: SOURCE, sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex'), snapshotHex: snapshot.toString('hex'), bytes: snapshot.length, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777, directStatus: 0 };
      t.diagnostic('B3 A2 old-source snapshot ' + JSON.stringify(observed));
      assert.equal(observed.mode, 0o600, 'security contract: replacement must narrow the existing file');
    } finally { process.umask(old); clean(fx); }
  });
} else {
  test('T0 TAP oracle', () => {
    const success = 'TAP version 13\n1..2\nok 1 - inner one\nok 2 - inner two\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
    assert.doesNotThrow(() => assertRootTap(success));
    assert.throws(() => assertRootTap(success.replace('# cancelled 0', '# cancelled 1')));
    assert.throws(() => assertRootTap(success.replace('# skipped 0', '# skipped 1')));
    assert.throws(() => assertRootTap(success.replace('ok 2 - inner two', 'ok 2 - inner two # SKIP absent')));
    assert.throws(() => assertRootTap(success.replace('ok 2 - inner two', 'ok 2 - inner two # TODO absent')));
    assert.throws(() => assertRootTap(success.replace('ok 2 - inner two', 'ok 2 - inner two # CANCELLED')));
  });
  test('T1 creation', async () => {
    const fx = fixture(); const old = process.umask(0o022); const events = [];
    const traced = new Proxy(fs, { get(target, key) {
      if (key === 'writeFileSync') return (file, data, ...rest) => {
        if (typeof file === 'number') {
          const st = target.fstatSync(file);
          events.push(['first-write', st.uid, st.gid, st.mode & 0o7777]);
        }
        return target.writeFileSync(file, data, ...rest);
      };
      if (key === 'linkSync') return (from, to) => {
        if (path.basename(String(to)) === path.basename(fx.envFile)) {
          const st = target.statSync(from); const bytes = target.readFileSync(from);
          events.push(['publish', st.uid, st.gid, st.mode & 0o7777, st.size, bytes.length]);
        }
        return target.linkSync(from, to);
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    }});
    try {
      fs.writeFileSync(fx.settingsJs, '\'use strict\';\n'); fs.writeFileSync(fx.flowsJson, '[]\n');
      const state = hooks(fx, { fs: traced, events, env: { OSI_BOOTSTRAP_PATCH_SETTINGS: '1' } });
      await state.api.run([]);
      assert.equal(mode(fx.envFile), 0o600);
      const stat = fs.statSync(fx.envFile);
      assert.equal(stat.uid, 0); assert.equal(stat.gid, 0); assert.equal(stat.nlink, 1);
      assert.ok(fs.readFileSync(fx.envFile).includes(Buffer.from('CHIRPSTACK_API_KEY=')));
      assert.deepEqual(events.find(x => x[0] === 'first-write'), ['first-write', 0, 0, 0o600]);
      const published = events.find(x => x[0] === 'publish');
      assert.deepEqual(published.slice(0, 4), ['publish', 0, 0, 0o600]);
      assert.equal(published[4], published[5], 'complete byte count verified before publication');
      assert.ok(events.findIndex(x => x[0] === 'first-write') < events.findIndex(x => x[0] === 'publish'));
      assert.doesNotMatch(JSON.stringify(events), new RegExp(API_KEY));
      for (const mask of [0o077, 0o000, 0o777]) {
        process.umask(mask); const other = fixture();
        try { await hooks(other).api.run([]); assert.equal(mode(other.envFile), 0o600); assert.equal(fs.statSync(other.envFile).uid, 0); }
        finally { clean(other); }
      }
    } finally { process.umask(old); clean(fx); }
  });
  test('T2 narrowing', async () => {
    for (const initial of [0o644, 0o666, 0o600, 0o400, 0o4644]) {
      const fx = fixture(); const bytes = Buffer.from('CHIRPSTACK_API_KEY=' + API_KEY + '\n');
      fs.writeFileSync(fx.envFile, bytes, { mode: initial }); fs.chmodSync(fx.envFile, initial);
      try {
        const api = hooks(fx).api; await api.run(['--secure-env-file']);
        const first = fs.statSync(fx.envFile);
        assert.equal(mode(fx.envFile), 0o600); assert.equal(first.uid, 0); assert.equal(first.gid, 0);
        assert.deepEqual(fs.readFileSync(fx.envFile), bytes);
        await api.run(['--secure-env-file']);
        assert.equal(fs.statSync(fx.envFile).ino, first.ino);
      } finally { clean(fx); }
    }
    const missing = fixture();
    try { await hooks(missing).api.run(['--secure-env-file']); assert.equal(fs.existsSync(missing.envFile), false); }
    finally { clean(missing); }
    const backupOnly = fixture(); const backupBytes = Buffer.from('OLD_BACKUP=retained\n');
    fs.writeFileSync(backupOnly.backup, backupBytes, { mode: 0o644 }); fs.chmodSync(backupOnly.backup, 0o644);
    try {
      await hooks(backupOnly).api.run(['--secure-env-file']);
      assert.equal(fs.existsSync(backupOnly.envFile), false);
      assert.deepEqual(fs.readFileSync(backupOnly.backup), backupBytes);
      assert.equal(mode(backupOnly.backup), 0o600);
    } finally { clean(backupOnly); }
    const nonroot = fixture(); const nonrootBytes = Buffer.from('UNCHANGED=1\n');
    fs.writeFileSync(nonroot.envFile, nonrootBytes, { mode: 0o644 }); fs.chmodSync(nonroot.envFile, 0o644);
    try {
      const result = cp.spawnSync(process.execPath, [SOURCE, '--secure-env-file'], {
        encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ENV_FILE: nonroot.envFile },
        uid: 65534, gid: 65534, timeout: 5000, maxBuffer: 2 * 1024 * 1024
      });
      assert.equal(result.status, 74);
      assert.deepEqual(fs.readFileSync(nonroot.envFile), nonrootBytes);
      assert.equal(mode(nonroot.envFile), 0o644);
    } finally { clean(nonroot); }
    const foreign = fixture(); const foreignBytes = Buffer.from('FOREIGN=preserved\n');
    fs.writeFileSync(foreign.envFile, foreignBytes, { mode: 0o640 }); fs.chmodSync(foreign.envFile, 0o640); fs.chownSync(foreign.envFile, 65534, 65534);
    try {
      await hooks(foreign).api.run(['--secure-env-file']);
      const stat = fs.statSync(foreign.envFile);
      assert.equal(stat.uid, 0); assert.equal(stat.gid, 0); assert.equal(mode(foreign.envFile), 0o600);
      assert.deepEqual(fs.readFileSync(foreign.envFile), foreignBytes);
    } finally { clean(foreign); }
  });
  test('T3 full merge', async () => {
    const fx = fixture(); const prior = Buffer.from('# operator\r\n\r\nAGROSCOPE_LABEL=é🌱\r\nLOG_LEVEL=debug\nDEVICE_EUI=0016C001F1000001\r\nCHIRPSTACK_EXTRA=operator\nQUOTED="a=b"\r\nDUP=one\nDUP=two\r\nFINAL=value');
    fs.writeFileSync(fx.envFile, prior, { mode: 0o644 }); fs.chmodSync(fx.envFile, 0o644);
    try {
      await hooks(fx).api.run([]);
      const result = fs.readFileSync(fx.envFile);
      assert.deepEqual(result.subarray(0, prior.length), prior, 'all unrelated raw line bytes, endings, duplicates and unterminated final line survive');
      for (const line of ['# operator\r', 'AGROSCOPE_LABEL=é🌱\r', 'LOG_LEVEL=debug', 'DEVICE_EUI=0016C001F1000001', 'CHIRPSTACK_EXTRA=operator', 'QUOTED="a=b"\r', 'DUP=one', 'DUP=two\r', 'FINAL=value']) assert.ok(result.includes(Buffer.from(line)));
      assert.equal(fs.statSync(fx.envFile).size, Buffer.byteLength(result.toString('utf8')));
      assert.equal(mode(fx.envFile), 0o600);
    } finally { clean(fx); }
    const bad = fixture(); const bytes = Buffer.from([0x41, 0x3d, 0xe9]);
    fs.writeFileSync(bad.envFile, bytes, { mode: 0o644 }); fs.chmodSync(bad.envFile, 0o644);
    try {
      const state = hooks(bad);
      await assert.rejects(state.api.run([]), credentialError);
      assert.deepEqual(fs.readFileSync(bad.envFile), bytes); assert.equal(mode(bad.envFile), 0o600);
      assert.equal(state.events.some(x => x[0] === 'client' || x[0] === 'api-key'), false);
    } finally { clean(bad); }
  });
  test('T4 soil repair', async () => {
    const fx = fixture();
    const content = 'CHIRPSTACK_API_KEY=' + API_KEY + '\r\nCHIRPSTACK_APP_SENSORS=00000000-0000-4000-8000-000000000001\r\nCHIRPSTACK_PROFILE_KIWI=00000000-0000-4000-8000-000000000011\r\nCHIRPSTACK_PROFILE_RAK10701=00000000-0000-4000-8000-000000000012\r\nCHIRPSTACK_PROFILE_CLOVER=00000000-0000-4000-8000-000000000012\r\nOPERATOR=é🌱\r\n';
    const bytes = Buffer.from(content); fs.writeFileSync(fx.envFile, bytes, { mode: 0o644 }); fs.chmodSync(fx.envFile, 0o644);
    try {
      const state = hooks(fx); await state.api.run(['--repair-soil-profiles']);
      assert.equal(mode(fx.envFile), 0o600);
      assert.ok(fs.readFileSync(fx.envFile).includes(Buffer.from('OPERATOR=é🌱\r')));
      assert.ok(state.events.some(x => x[0] === 'client'));
      const repaired = fs.readFileSync(fx.envFile);
      assert.ok(repaired.includes(Buffer.from('OPERATOR=é🌱\r\n')));
      assert.ok(repaired.includes(Buffer.from('CHIRPSTACK_PROFILE_CLOVER=00000000-0000-4000-8000-')));
      const changed = Buffer.from(content.replace('OPERATOR=', 'OPERATOR_EDIT='));
      assert.throws(() => state.api.writeEnvFileAtomic('OPERATOR=write\n', changed), credentialError);
      fs.writeFileSync(fx.envFile, Buffer.from([0xe9]));
      assert.throws(() => state.api.readEnvFileForMutation(), credentialError);
    } finally { clean(fx); }
    const noOp = fixture();
    const clover = '00000000-0000-4000-8000-000000000013';
    const rak = '00000000-0000-4000-8000-000000000012';
    const noOpBytes = Buffer.from('CHIRPSTACK_API_KEY=' + API_KEY + '\r\nCHIRPSTACK_PROFILE_RAK10701=' + rak + '\r\nCHIRPSTACK_PROFILE_CLOVER=' + clover + '\r\nOPERATOR=é🌱\r\n');
    fs.writeFileSync(noOp.envFile, noOpBytes, { mode: 0o644 }); fs.chmodSync(noOp.envFile, 0o644);
    try {
      const state = hooks(noOp, { uci: {
        'osi-server.cloud.chirpstack_profile_clover': clover,
        'osi-server.cloud.chirpstack_profile_rak10701': rak
      }});
      await state.api.run(['--repair-soil-profiles']);
      assert.deepEqual(fs.readFileSync(noOp.envFile), noOpBytes);
      assert.equal(mode(noOp.envFile), 0o600);
      assert.equal(state.events.some(x => ['createProfile','updateProfile','uci-write'].includes(x[0])), false);
      assert.ok(state.events.some(x => x[0] === 'uci-read'), 'no-op path may read UCI for precedence');
    } finally { clean(noOp); }
    const malformed = fixture(); const malformedBytes = Buffer.concat([Buffer.from('CHIRPSTACK_API_KEY=' + API_KEY + '\nOPERATOR='), Buffer.from([0xe9, 0x0a])]);
    fs.writeFileSync(malformed.envFile, malformedBytes, { mode: 0o644 });
    try {
      const state = hooks(malformed);
      await assert.rejects(state.api.run(['--repair-soil-profiles']), credentialError);
      assert.deepEqual(fs.readFileSync(malformed.envFile), malformedBytes); assert.equal(mode(malformed.envFile), 0o600);
      assert.equal(state.events.some(x => ['client','api-key','uci-read','uci-write','createProfile','updateProfile'].includes(x[0])), false, 'malformed bytes stop before profile, key and UCI work');
    } finally { clean(malformed); }
    const missingToken = fixture(); fs.writeFileSync(missingToken.envFile, 'CHIRPSTACK_APP_SENSORS=app\n');
    try {
      const state = hooks(missingToken, { env: { CHIRPSTACK_API_KEY: '' } });
      await assert.rejects(state.api.run(['--repair-soil-profiles']), /repair mode never creates one/);
      assert.equal(state.events.some(x => ['client','api-key','uci-write'].includes(x[0])), false);
    } finally { clean(missingToken); }
    const missingCodec = fixture(); fs.writeFileSync(missingCodec.envFile, 'CHIRPSTACK_API_KEY=' + API_KEY + '\n');
    try {
      const state = hooks(missingCodec, { env: { TEKTELIC_CODEC_PATH: path.join(missingCodec.dir, 'absent-codec.js') } });
      await assert.rejects(state.api.run(['--repair-soil-profiles']), /Tektelic codec missing/);
      assert.equal(state.events.some(x => ['client','api-key','uci-write'].includes(x[0])), false);
    } finally { clean(missingCodec); }
    const failedRpc = fixture(); fs.writeFileSync(failedRpc.envFile, 'CHIRPSTACK_API_KEY=' + API_KEY + '\n');
    try {
      const state = hooks(failedRpc, { failApi: true });
      await assert.rejects(state.api.run(['--repair-soil-profiles']), /synthetic soil RPC failure/);
      assert.ok(state.events.some(x => x[0] === 'client'));
      assert.equal(state.events.some(x => ['api-key','uci-write'].includes(x[0])), false, 'RPC failure does not fall back to full provisioning or UCI writes');
    } finally { clean(failedRpc); }
  });
  test('T5 raw backup', async () => {
    const fx = fixture(); const bytes = Buffer.from([0x41, 0x3d, 0xe9, 0x0d, 0x0a, 0xf0, 0x9f, 0x8c, 0xb1]);
    fs.writeFileSync(fx.envFile, bytes, { mode: 0o644 }); fs.chmodSync(fx.envFile, 0o644);
    try {
      const api = hooks(fx).api; await api.backupEnvFile();
      assert.deepEqual(fs.readFileSync(fx.backup), bytes); assert.equal(fs.statSync(fx.backup).size, bytes.length);
      assert.equal(mode(fx.backup), 0o600); assert.equal(fs.statSync(fx.backup).uid, 0);
      const saved = fs.statSync(fx.backup); fs.writeFileSync(fx.envFile, 'different');
      await api.backupEnvFile(); assert.equal(fs.statSync(fx.backup).ino, saved.ino); assert.deepEqual(fs.readFileSync(fx.backup), bytes);
    } finally { clean(fx); }
    const existing = fixture(); const existingLive = Buffer.from('LIVE=changed\n'); const existingBackup = Buffer.from([0x4f,0x50,0x3d,0xe9,0x0d,0x0a]);
    fs.writeFileSync(existing.envFile, existingLive, { mode: 0o600 });
    fs.writeFileSync(existing.backup, existingBackup, { mode: 0o644 }); fs.chmodSync(existing.backup, 0o644);
    try {
      const inode = fs.statSync(existing.backup).ino;
      await hooks(existing).api.backupEnvFile();
      assert.equal(fs.statSync(existing.backup).ino, inode); assert.equal(mode(existing.backup), 0o600);
      assert.deepEqual(fs.readFileSync(existing.backup), existingBackup);
    } finally { clean(existing); }
    const missing = fixture();
    try {
      const state = hooks(missing);
      assert.throws(() => state.api.backupEnvFile(), credentialError);
      assert.equal(state.events.some(x => ['client','api-key','uci-write'].includes(x[0])), false);
    } finally { clean(missing); }
  });
  test('T6 hostile paths and CLI', async () => {
    const fx = fixture(); const cliSource = path.join(fx.dir, 'candidate-chirpstack-bootstrap.js'); fs.copyFileSync(SOURCE, cliSource);
    const sentinel = path.join(fx.dir, 'sentinel');
    fs.writeFileSync(sentinel, 'untouched'); fs.chmodSync(sentinel, 0o644);
    try {
      fs.symlinkSync(sentinel, fx.envFile);
      const result = cli(['--secure-env-file'], fx, { source: cliSource });
      assert.equal(result.status, 74); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched'); assert.equal(mode(sentinel), 0o644);
      fs.unlinkSync(fx.envFile);
      fs.writeFileSync(fx.envFile, 'synthetic=secret\n', { mode: 0o644 }); fs.chmodSync(fx.envFile, 0o644);
      const guard = noExternalPreload(fx);
      const safe = cli(['--secure-env-file'], fx, { source: cliSource, preload: guard.preload, env: { OSI_GUARD_TARGET: cliSource, OSI_GUARD_TRACE: guard.trace } });
      assert.equal(safe.status, 0, safe.stderr);
      assert.equal(mode(fx.envFile), 0o600);
      assert.equal(fs.existsSync(guard.trace), false, 'file-only CLI made no external helper load');
      const control = path.join(fx.dir, 'positive-control.cjs');
      fs.writeFileSync(control, "require('definitely-not-installed-by-test');\n");
      const controlResult = cp.spawnSync(process.execPath, [control], { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require ' + guard.preload, OSI_GUARD_TARGET: control, OSI_GUARD_TRACE: guard.trace } });
      assert.notEqual(controlResult.status, 0);
      assert.match(fs.readFileSync(guard.trace, 'utf8'), /definitely-not-installed-by-test/);
      for (const args of [['--secure-env-file', '--backup-env-file'], ['--secure-env-file', '--secure-env-file'], ['--backup-env-file=value'], ['--unknown']]) {
        const invalid = cli(args, fx, { source: cliSource, preload: guard.preload, env: { OSI_GUARD_TARGET: cliSource, OSI_GUARD_TRACE: guard.trace } });
        assert.equal(invalid.status, 2, args.join(' '));
      }
      assert.equal(fs.existsSync(fx.backup), false);
      const dangling = fixture();
      try { fs.symlinkSync(path.join(dangling.dir, 'absent'), dangling.envFile); assert.equal(cli(['--secure-env-file'], dangling, { source: cliSource }).status, 74); }
      finally { clean(dangling); }
      const hardlink = fixture(); const hardTarget = path.join(hardlink.dir, 'sentinel');
      fs.writeFileSync(hardTarget, 'HARDLINK=untouched\n', { mode: 0o640 });
      try {
        fs.linkSync(hardTarget, hardlink.envFile); const before = fs.statSync(hardTarget);
        assert.equal(cli(['--secure-env-file'], hardlink, { source: cliSource }).status, 74);
        assert.deepEqual(fs.readFileSync(hardTarget), Buffer.from('HARDLINK=untouched\n'));
        assert.equal(mode(hardTarget), 0o640); assert.equal(fs.statSync(hardTarget).ino, before.ino); assert.equal(fs.statSync(hardTarget).nlink, 2);
      } finally { clean(hardlink); }
      const backupLink = fixture(); const backupTarget = path.join(backupLink.dir, 'backup-sentinel');
      fs.writeFileSync(backupTarget, 'BACKUP=untouched\n', { mode: 0o644 });
      try {
        fs.symlinkSync(backupTarget, backupLink.backup);
        assert.equal(cli(['--secure-env-file'], backupLink, { source: cliSource }).status, 74);
        assert.equal(fs.readFileSync(backupTarget, 'utf8'), 'BACKUP=untouched\n'); assert.equal(mode(backupTarget), 0o644);
      } finally { clean(backupLink); }
      const directory = fixture();
      try { fs.mkdirSync(directory.envFile); assert.equal(cli(['--secure-env-file'], directory, { source: cliSource }).status, 74); }
      finally { clean(directory); }
      const fifo = fixture();
      try {
        cp.execFileSync('mkfifo', [fifo.envFile]);
        assert.equal(cli(['--secure-env-file'], fifo, { source: cliSource }).status, 74);
      } finally { clean(fifo); }
      const socket = fixture(); const server = net.createServer();
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket.envFile, resolve); });
        assert.equal(cli(['--secure-env-file'], socket, { source: cliSource }).status, 74);
      } finally {
        if (server.listening) await new Promise(resolve => server.close(resolve));
        clean(socket);
      }
      const parentLink = fixture(); const realParent = path.join(parentLink.dir, 'real');
      const aliasParent = path.join(parentLink.dir, 'alias');
      fs.mkdirSync(realParent); fs.symlinkSync(realParent, aliasParent);
      const parentTarget = path.join(realParent, 'env');
      fs.writeFileSync(parentTarget, 'PARENT=untouched\n', { mode: 0o644 });
      try {
        assert.equal(cli(['--secure-env-file'], parentLink, { source: cliSource, env: { ENV_FILE: path.join(aliasParent, 'env') } }).status, 74);
        assert.equal(fs.readFileSync(parentTarget, 'utf8'), 'PARENT=untouched\n'); assert.equal(mode(parentTarget), 0o644);
      } finally { clean(parentLink); }
      const unsupported = hooks(fx, { fs: new Proxy(fs, { get(target, key) {
        if (key === 'constants') return { ...target.constants, O_NOFOLLOW: undefined };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      }}) });
      assert.throws(() => unsupported.api.secureEnvFiles(), credentialError);
      const noProc = hooks(fx, { fs: new Proxy(fs, { get(target, key) {
        if (key === 'statSync') return (file, ...args) => {
          if (file === '/proc/self/fd') throw syntheticError('ENOENT');
          return target.statSync(file, ...args);
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      }}) });
      assert.throws(() => noProc.api.secureEnvFiles(), credentialError);
      const confined = guardedProductFs(fx);
      const outside = path.join(fx.dir, '..', path.basename(fx.dir) + '-outside-sentinel');
      fs.writeFileSync(outside, 'OUTSIDE=unchanged\n', { mode: 0o600 });
      try {
        assert.throws(() => confined.writeFileSync(outside, 'MUST_NOT_WRITE\n'), /escaped fixture/);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE=unchanged\n');
      } finally { fs.unlinkSync(outside); }
      const soilTemp = path.join(fx.dir, '.soil-repair.tmp');
      fs.writeFileSync(soilTemp, 'OLD_TMP=untouched\n', { mode: 0o640 });
      await hooks(fx).api.writeEnvFile({ MANAGED: 'updated' });
      assert.deepEqual(fs.readFileSync(soilTemp), Buffer.from('OLD_TMP=untouched\n'));
      assert.equal(mode(soilTemp), 0o640);
      const collision = fixture(); const colliding = path.join(collision.dir, '.chirpstack.env.tmp-collision');
      fs.writeFileSync(collision.envFile, 'OLD=whole\n', { mode: 0o600 });
      fs.writeFileSync(colliding, 'COLLISION=untouched\n', { mode: 0o600 });
      try {
        const injected = new Proxy(fs, { get(target, key) {
          if (key === 'mkdtempSync') return () => { throw syntheticError('EEXIST'); };
          const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
        }});
        assert.throws(() => hooks(collision, { fs: injected }).api.writeEnvFile({ MANAGED: 'value' }), error => {
          credentialError(error); assert.equal(error.phase, 'stage'); assert.equal(error.published, false); return true;
        });
        assert.deepEqual(fs.readFileSync(collision.envFile), Buffer.from('OLD=whole\n'));
        assert.deepEqual(fs.readFileSync(colliding), Buffer.from('COLLISION=untouched\n'));
      } finally { clean(collision); }
    } finally { clean(fx); }
  });
  test('T7 deploy routing', () => {
    const deploy = fs.readFileSync(DEPLOY, 'utf8');
    const marked = (begin, end) => {
      const a = deploy.indexOf('# issue-183 ' + begin + ' begin');
      const b = deploy.indexOf('# issue-183 ' + end + ' end', a);
      assert.ok(a >= 0 && b > a, begin + ' fragment markers');
      return deploy.slice(a, b + ('# issue-183 ' + end + ' end').length);
    };
    const early = marked('early secure', 'early secure');
    const gen2 = marked('Gen2', 'Gen2');
    const soil = marked('soil', 'soil');
    const final = marked('final secure', 'final secure');
    const realNode = process.execPath;
    const runFragments = (fx, initial, opts = {}) => {
      const canonical = path.join(fx.dir, 'canonical.env');
      const decoy = path.join(fx.dir, 'decoy.env');
      const log = path.join(fx.dir, 'commands.log');
      const trace = path.join(fx.dir, 'publisher-events.jsonl');
      const preload = path.join(fx.dir, 'publisher-preload.cjs');
      const sourceCopy = path.join(fx.dir, 'candidate-chirpstack-bootstrap.js'); fs.copyFileSync(SOURCE, sourceCopy);
      fs.writeFileSync(preload, publisherPreloadSource({ ...fx, envFile: canonical, sourceFile: sourceCopy }, opts.publisherFault, opts.publisherMode, trace));
      fs.writeFileSync(fx.settingsJs, "'use strict';\n");
      fs.writeFileSync(fx.flowsJson, '[]\n');
      if (initial !== null) fs.writeFileSync(canonical, initial, { mode: 0o644 });
      fs.writeFileSync(decoy, 'DECOY=untouched\n', { mode: 0o644 });
      const script = [
        'set -eu',
        'CHIRPSTACK_ENV_FILE=' + JSON.stringify(canonical),
        'MIGRATION_MARKER=' + JSON.stringify(path.join(fx.dir, 'migration')),
        'export CHIRPSTACK_ENV_FILE MIGRATION_MARKER',
        'SECURE_COUNT=0',
        'node() {',
        '  printf "%s|%s\\n" "$ENV_FILE" "$*" >> "$COMMAND_LOG"',
        '  case "$*" in',
        '    *--secure-env-file*) SECURE_COUNT=$((SECURE_COUNT + 1)); if [ "$SECURE_FAIL_AT" -eq "$SECURE_COUNT" ]; then return "$SECURE_STATUS"; fi; "$REAL_NODE" "$SOURCE" --secure-env-file ;;',
        '    *--repair-soil-profiles*) if [ "$PUBLISHER_FAULT" = link ] || [ "$PUBLISHER_FAULT" = private-unlink ]; then rm -f "$CHIRPSTACK_ENV_FILE"; fi; "$REAL_NODE" "$SOURCE" --repair-soil-profiles $SOIL_EXTRA_ARGS ;;',
        '    *--backup-env-file*) if [ "$BACKUP_STATUS" -ne 0 ]; then return "$BACKUP_STATUS"; fi; "$REAL_NODE" "$SOURCE" --backup-env-file ;;',
        '    *) if [ "$GEN2_STATUS" -ne 0 ]; then return "$GEN2_STATUS"; fi; if [ "$PUBLISHER_FAULT" = link ] || [ "$PUBLISHER_FAULT" = private-unlink ]; then rm -f "$CHIRPSTACK_ENV_FILE"; fi; "$REAL_NODE" "$SOURCE" ;;',
        '  esac',
        '}',
        'export -f node',
        early, gen2, soil, final,
        ': > "$MIGRATION_MARKER"'
      ].join('\n');
      const commandLog = log;
      const result = cp.spawnSync('/bin/bash', ['-eu', '-c', script], {
        encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin', BASH_ENV: '', ENV_FILE: decoy, REAL_NODE: realNode, SOURCE: sourceCopy,
          COMMAND_LOG: commandLog, PUBLISHER_MODE: String(opts.publisherMode || ''),
          GEN2_STATUS: String(opts.gen2Status ?? 1), SOIL_EXTRA_ARGS: String(opts.soilExtraArgs || ''),
          SECURE_FAIL_AT: String(opts.secureFailAt ?? 0), SECURE_STATUS: String(opts.secureStatus ?? 74),
          BACKUP_STATUS: String(opts.backupStatus ?? 0), PUBLISHER_FAULT: String(opts.publisherFault || ''), NODE_OPTIONS: '--require ' + preload,
          ISSUE183_FIXTURE: fx.dir, ISSUE183_SOURCE: SOURCE,
          ISSUE183_OPERATION: String(opts.publisherMode || ''), ISSUE183_FAULT: String(opts.publisherFault || ''),
          ISSUE183_UCI_STATE: JSON.stringify(opts.uci || {}), ISSUE183_TRACE: trace, ISSUE183_SOIL_API_FAILURE: String(opts.soilApiFailure || ''), ISSUE183_VIRTUAL_ROOT: String(opts.virtualRoot || process.env.OSI_ISSUE183_SHADOW_ROOT || ''),
          SETTINGS_JS: fx.settingsJs, FLOWS_JSON: fx.flowsJson, CHIRPSTACK_API_KEY: API_KEY,
          TEKTELIC_CODEC_PATH: TEKTELIC_CODEC,
          STREGA_CODEC_PATH: path.join(fx.dir, 'codecs/strega.js'), STREGA_GEN2_CODEC_PATH: path.join(fx.dir, 'codecs/strega-gen2.js'),
          LSN50_CODEC_PATH: path.join(fx.dir, 'codecs/lsn50.js'), S2120_CODEC_PATH: path.join(fx.dir, 'codecs/s2120.js'),
          LORAIN_CODEC_PATH: path.join(fx.dir, 'codecs/lorain.js'), UC512_CODEC_PATH: path.join(fx.dir, 'codecs/uc512.js'),
          SDI12_CODEC_PATH: path.join(fx.dir, 'codecs/sdi12.js'),
          OSI_BOOTSTRAP_PATCH_SETTINGS: opts.publisherMode === 'full' ? '1' : '0',
          ...opts.env
        }
      });
      const traceEvents = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return JSON.parse(line); } catch { return []; } }) : [];
      return { result, canonical, decoy, log, trace, traceEvents, preload, source: sourceCopy, migration: path.join(fx.dir, 'migration') };
    };
    const sensors = 'CHIRPSTACK_APP_SENSORS=00000000-0000-4000-8000-000000000001\n';
    for (const [label, initial] of [
      ['Gen2 present and no-op soil', sensors + 'CHIRPSTACK_PROFILE_STREGA_GEN2=id\n'],
      ['Gen2 absent and provisioning branch', sensors + 'CHIRPSTACK_API_KEY=' + API_KEY + '\nOPERATOR=é🌱\n'],
      ['canonical absent', null]
    ]) {
      const fx = fixture();
      try {
        const run = runFragments(fx, initial);
        assert.equal(run.result.status, 0, label + ': ' + run.result.stderr);
        assert.deepEqual(fs.readFileSync(run.decoy), Buffer.from('DECOY=untouched\n'));
        assert.equal(mode(run.decoy), 0o644);
        assert.equal(fs.existsSync(run.migration), true);
        const calls = fs.readFileSync(run.log, 'utf8').trim().split('\n').filter(Boolean);
        assert.ok(calls.length >= 2);
        assert.ok(calls.every(line => line.startsWith(run.canonical + '|')), 'all invocations bind canonical ENV_FILE');
        if (initial === null) assert.equal(fs.existsSync(run.canonical), false);
        else assert.equal(mode(run.canonical), 0o600);
        if (initial && !initial.includes('CHIRPSTACK_PROFILE_STREGA_GEN2=')) {
          const backup = run.canonical + '.pre-gen2';
          assert.deepEqual(fs.readFileSync(backup), Buffer.from(initial));
          assert.equal(mode(backup), 0o600);
        }
      } finally { clean(fx); }
    }
    for (const status of [74, 2]) {
      const fx = fixture();
      try {
        const run = runFragments(fx, sensors + 'CHIRPSTACK_API_KEY=' + API_KEY + '\n', { gen2Status: status });
        assert.equal(run.result.status, status);
        assert.equal(fs.existsSync(run.migration), false);
        assert.equal(fs.existsSync(run.canonical + '.pre-gen2'), true);
      } finally { clean(fx); }
    }
    const soilUsage = fixture();
    try {
      const run = runFragments(soilUsage, sensors + 'CHIRPSTACK_PROFILE_STREGA_GEN2=id\nCHIRPSTACK_API_KEY=' + API_KEY + '\n', { soilExtraArgs: '--unknown' });
      assert.equal(run.result.status, 2, 'real CLI usage failure remains fatal in deploy');
      assert.equal(fs.existsSync(run.migration), false);
      assert.equal(fs.readFileSync(run.log, 'utf8').split('\n').filter(line => line.includes('--secure-env-file')).length, 1, 'final safety check did not erase status 2');
    } finally { clean(soilUsage); }
    const soilWarning = fixture();
    const soilPrior = sensors + 'CHIRPSTACK_PROFILE_STREGA_GEN2=id\nCHIRPSTACK_API_KEY=' + API_KEY + '\n';
    try {
      const run = runFragments(soilWarning, soilPrior, { soilApiFailure: '1' });
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.match((run.result.stdout || '') + (run.result.stderr || ''), /WARN.*Kiwi\/Clover profile repair failed/i);
      assert.equal(fs.existsSync(run.migration), true, 'soil API status 1 warns and deploy continues');
      assert.equal(fs.existsSync(run.canonical), true);
      assert.deepEqual(fs.readFileSync(run.canonical), Buffer.from(soilPrior));
      const st = fs.statSync(run.canonical);
      assert.equal(st.uid, 0); assert.equal(st.gid, 0); assert.equal(st.nlink, 1); assert.equal(st.mode & 0o7777, 0o600);
    } finally { clean(soilWarning); }
    for (const status of [1, 2, 74]) {
      const fx = fixture();
      try {
        const run = runFragments(fx, sensors + 'CHIRPSTACK_PROFILE_STREGA_GEN2=id\n', { secureFailAt: 1, secureStatus: status });
        assert.equal(run.result.status, status);
        assert.equal(fs.existsSync(run.migration), false);
        assert.equal(fs.readFileSync(run.log, 'utf8').split('\n').filter(Boolean).length, 1);
      } finally { clean(fx); }
    }
    for (const status of [1, 2, 74]) {
      const fx = fixture();
      try {
        const run = runFragments(fx, sensors + 'CHIRPSTACK_API_KEY=' + API_KEY + '\n', { backupStatus: status });
        assert.equal(run.result.status, status);
        assert.equal(fs.existsSync(run.migration), false);
        const calls = fs.readFileSync(run.log, 'utf8').split('\n').filter(Boolean);
        assert.ok(calls.some(line => line.endsWith('--backup-env-file')));
        assert.equal(calls.filter(line => line.endsWith('|/srv/node-red/chirpstack-bootstrap.js')).length, 0, 'backup failure precedes full bootstrap');
      } finally { clean(fx); }
    }
    for (const status of [1, 2, 74]) {
      const fx = fixture();
      try {
        const run = runFragments(fx, sensors + 'CHIRPSTACK_API_KEY=' + API_KEY + '\n', { gen2Status: 1, secureFailAt: 2, secureStatus: status });
        assert.equal(run.result.status, status);
        assert.equal(fs.existsSync(run.migration), false);
        assert.equal(fs.readFileSync(run.log, 'utf8').split('\n').filter(line => line.includes('--secure-env-file')).length, 2);
      } finally { clean(fx); }
    }
    for (const operation of ['full', 'soil']) {
      const fx = fixture();
      const initial = sensors + (operation === 'soil' ? 'CHIRPSTACK_PROFILE_STREGA_GEN2=id\n' : '') + 'CHIRPSTACK_API_KEY=' + API_KEY + '\n';
      try {
        const run = runFragments(fx, initial, { publisherMode: operation, publisherFault: 'dir-fsync', gen2Status: operation === 'full' ? 0 : 1 });
        assert.equal(run.result.status, 74, operation + ' real publisher failure must stay fatal: ' + JSON.stringify({ stdout: run.result.stdout, stderr: run.result.stderr, events: run.traceEvents, calls: fs.existsSync(run.log) ? fs.readFileSync(run.log, 'utf8') : '' }));
        assert.equal(fs.existsSync(run.migration), false, operation + ' failure stops later deploy markers');
        assert.equal(mode(run.canonical), 0o600);
        if (operation === 'full') assert.deepEqual(fs.readFileSync(run.canonical + '.pre-gen2'), Buffer.from(initial));
        const canonicalFx = { ...fx, envFile: run.canonical };
        assert.equal(fs.existsSync(run.canonical), true, 'actual canonical file exists after publisher run');
        const before = fs.readFileSync(run.canonical);
        const metadata = cli(['--secure-env-file'], canonicalFx, { source: run.source, ...(process.env.OSI_ISSUE183_SHADOW_ROOT === '1' ? { preload: run.preload, env: { ISSUE183_VIRTUAL_ROOT: '1' } } : {}) });
        assert.equal(metadata.status, 0, 'metadata probe targets run.canonical');
        assert.deepEqual(fs.readFileSync(run.canonical), before, 'metadata probe preserves canonical bytes');
        const st = fs.statSync(run.canonical);
        assert.equal(st.uid, 0); assert.equal(st.gid, 0); assert.equal(st.nlink, 1); assert.equal(st.mode & 0o7777, 0o600);
      } finally { clean(fx); }
    }
    for (const operation of ['full', 'soil']) {
      const faultMatrix = ['open','fchown','fchmod','write','file-fsync','stage-close','rename','link','verify-read','dir-fsync','private-unlink','published-close','rmdir','outer-close'];
      // Soil repair replaces an existing expected snapshot by rename; create-only links are covered by full provisioning and backup cases.
      const operationFaults = operation === 'soil' ? faultMatrix.filter(fault => !['link','private-unlink'].includes(fault)) : faultMatrix;
      for (const fault of operationFaults) {
        const fx = fixture();
        const initial = sensors + (operation === 'soil' ? 'CHIRPSTACK_PROFILE_STREGA_GEN2=id\n' : '') + 'CHIRPSTACK_API_KEY=' + API_KEY + '\n';
        try {
          const env = ['link','private-unlink'].includes(fault) && operation === 'soil'
            ? {
              CHIRPSTACK_APP_SENSORS: '00000000-0000-4000-8000-000000000001',
              CHIRPSTACK_PROFILE_STREGA_GEN2: 'synthetic-gen2',
              CHIRPSTACK_PROFILE_RAK10701: '00000000-0000-4000-8000-000000000012',
              CHIRPSTACK_PROFILE_CLOVER: '00000000-0000-4000-8000-000000000012'
            }
            : {};
          const run = runFragments(fx, initial, { publisherMode: operation, publisherFault: fault, gen2Status: operation === 'full' ? 0 : 1, env });
          assert.equal(run.result.status, 74, operation + '/' + fault + ' classified by actual CLI handler');
          assert.match(run.result.stderr, /Credential env-file operation failed/);
          assert.doesNotMatch(run.result.stderr, /synthetic stage|synthetic verify|CHIRPSTACK_API_KEY=/);
          assert.equal(fs.existsSync(run.migration), false);
          assert.ok(run.traceEvents.some(event => event.kind === 'fault' && event.fault === fault), operation + '/' + fault + ' injection fired');
          const summary = run.traceEvents.find(event => event.kind === 'fault-summary' && event.fault === fault && event.faultFired === true);
          assert.ok(summary, operation + '/' + fault + ' child reported the injected fault');
          const priorSideEffect = operation === 'soil'
            ? run.traceEvents.some(event => Array.isArray(event) && event[0] === 'uci-write')
            : run.traceEvents.some(event => Array.isArray(event) && ['client','createApplication','createProfile','api-key'].includes(event[0]));
          assert.ok(priorSideEffect, operation + '/' + fault + ' side-effect trace: ' + JSON.stringify({trace:run.traceEvents,calls:fs.existsSync(run.log)?fs.readFileSync(run.log, 'utf8'): ''}));
          const postPublication = ['verify-read','dir-fsync','private-unlink','published-close','rmdir','outer-close'].includes(fault);
          const metadataFx = { ...fx, envFile: run.canonical };
          const retainedExists = fs.existsSync(run.canonical);
          const retainedBytes = retainedExists ? fs.readFileSync(run.canonical) : null;
          const metadata = cli(['--secure-env-file'], metadataFx, {
            source: run.source,
            preload: run.preload,
            env: process.env.OSI_ISSUE183_SHADOW_ROOT === '1' ? { ISSUE183_VIRTUAL_ROOT: '1' } : {}
          });
          assert.equal(metadata.status, fault === 'private-unlink' ? 74 : 0, operation + '/' + fault + ' follow-up metadata probe status');
          assert.equal(fs.existsSync(run.canonical), retainedExists, operation + '/' + fault + ' metadata probe preserves file presence');
          if (retainedExists) {
            assert.deepEqual(fs.readFileSync(run.canonical), retainedBytes, operation + '/' + fault + ' metadata probe preserves canonical bytes');
            assert.equal(fs.statSync(run.canonical).nlink, fault === 'private-unlink' ? 2 : 1);
          }
          const diagnosticMatch = run.result.stderr.match(/Credential env-file operation failed (\{[^\n]+\})/);
          assert.ok(diagnosticMatch, operation + '/' + fault + ' emitted the safe credential diagnostic');
          const diagnostic = JSON.parse(diagnosticMatch[1]);
          assert.equal(diagnostic.published, postPublication);
          assert.equal(diagnostic.publication, postPublication ? (fault === 'private-unlink' ? 'link' : 'rename') : null);
        } finally { clean(fx); }
      }
    }
    const noSensors = fixture();
    try {
      const run = runFragments(noSensors, 'OPERATOR=kept\n', { gen2Status: 0 });
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.equal(fs.existsSync(run.migration), true);
      assert.equal(fs.statSync(run.canonical).mode & 0o7777, 0o600);
    } finally { clean(noSensors); }

  });
  test('T8 failure preservation', async () => {
    const faults = ['open', 'fchown', 'fchmod', 'write', 'file-fsync', 'stage-close', 'rename', 'link', 'verify-read', 'dir-fsync', 'private-unlink', 'published-close', 'rmdir', 'outer-close', 'rename-and-close'];
    for (const fault of faults) {
      const fx = fixture();
      const oldBytes = Buffer.from('OLD=complete\n');
      if (!['link', 'private-unlink'].includes(fault)) fs.writeFileSync(fx.envFile, oldBytes, { mode: 0o600 });
      let published = false;
      let faultFired = false;
      let failClose = fault === 'outer-close' || fault === 'rename-and-close';
      let failedOnce = false;
      const injected = new Proxy(fs, { get(target, key) {
        if (key === 'openSync' && fault === 'open') return (file, ...args) => {
          if (isStageEnvPath(file, fx.envFile, target)) { faultFired = true; throw syntheticError('EIO'); }
          return target.openSync(file, ...args);
        };
        if (key === 'fchownSync' && fault === 'fchown') return fd => { if (isStageEnvPath(fd, fx.envFile, target)) { faultFired = true; throw syntheticError('EPERM'); } return target.fchownSync(fd, 0, 0); };
        if (key === 'fchmodSync' && fault === 'fchmod') return (fd, bits) => { if (isStageEnvPath(fd, fx.envFile, target)) { faultFired = true; throw syntheticError('EIO'); } return target.fchmodSync(fd, bits); };
        if (key === 'writeFileSync' && fault === 'write') return (fd, bytes, ...args) => {
          if (!isStageEnvPath(fd, fx.envFile, target)) return target.writeFileSync(fd, bytes, ...args);
          faultFired = true;
          target.writeFileSync(fd, Buffer.from(bytes).subarray(0, Math.max(1, Math.floor(bytes.length / 2))), ...args);
          throw syntheticError('ENOSPC');
        };
        if (key === 'fsyncSync' && fault === 'file-fsync') return fd => {
          if (!target.fstatSync(fd).isDirectory() && isStageEnvPath(fd, fx.envFile, target)) { faultFired = true; throw syntheticError('EIO'); }
          if (!target.fstatSync(fd).isDirectory()) return target.fsyncSync(fd);
          return target.fsyncSync(fd);
        };
        if (key === 'renameSync' && ['rename', 'rename-and-close'].includes(fault)) return (from, to) => { if (isStageEnvPath(from, fx.envFile, target)) { faultFired = true; throw syntheticError('EIO'); } return target.renameSync(from, to); };
        if (key === 'linkSync' && fault === 'link') return (from, to) => { if (isStageEnvPath(from, fx.envFile, target)) { faultFired = true; throw syntheticError('EEXIST'); } return target.linkSync(from, to); };
        if (key === 'linkSync' && fault === 'private-unlink') return (from, to) => { const r = target.linkSync(from, to); published = true; return r; };
        if (key === 'renameSync' && fault === 'stage-close') return target.renameSync.bind(target);
        if (key === 'renameSync' || key === 'linkSync') {
          return (...args) => { const r = target[key](...args); published = true; return r; };
        }
        if (key === 'readFileSync' && fault === 'verify-read') return (file, ...args) => {
          if (published && typeof file === 'number' && path.resolve(target.readlinkSync('/proc/self/fd/' + file)) === path.resolve(fx.envFile)) { faultFired = true; throw syntheticError('EIO'); }
          return target.readFileSync(file, ...args);
        };
        if (key === 'fsyncSync' && fault === 'dir-fsync') return fd => {
          if (target.fstatSync(fd).isDirectory() && published && path.resolve(target.readlinkSync('/proc/self/fd/' + fd)) === path.dirname(fx.envFile)) { faultFired = true; throw syntheticError('EIO'); }
          return target.fsyncSync(fd);
        };
        if (key === 'unlinkSync' && fault === 'private-unlink') return file => {
          if (published && isStageEnvPath(file, fx.envFile, target)) { faultFired = true; throw syntheticError('EIO'); }
          return target.unlinkSync(file);
        };
        if (key === 'closeSync' && ['outer-close', 'rename-and-close', 'stage-close', 'published-close'].includes(fault)) return fd => {
          const st = target.fstatSync(fd);
          const name = target.readlinkSync('/proc/self/fd/' + fd);
          if (fault === 'stage-close' && st.isFile() && isStageEnvPath(fd, fx.envFile, target)) {
            faultFired = true; target.closeSync(fd); throw syntheticError('EIO');
          }
          if (fault === 'published-close' && published && st.isFile() && path.resolve(name) === path.resolve(fx.envFile)) {
            faultFired = true; target.closeSync(fd); throw syntheticError('EIO');
          }
          const outer = st.isDirectory() && path.resolve(name) === path.dirname(fx.envFile);
          target.closeSync(fd);
          if (outer && failClose && !failedOnce) { failedOnce = true; faultFired = true; throw syntheticError('EIO'); }
        };
        if (key === 'rmdirSync' && fault === 'rmdir') return file => { faultFired = true; throw syntheticError('EIO'); };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      }});
      try {
        assert.throws(() => hooks(fx, { fs: injected }).api.writeEnvFile({ MANAGED: 'new-value' }), error => {
          credentialError(error);
          const postPublish = ['verify-read','dir-fsync','private-unlink','published-close','rmdir','outer-close'].includes(fault);
          assert.equal(error.published, postPublish, fault);
          if (postPublish) assert.equal(error.publication, ['private-unlink'].includes(fault) ? 'link' : 'rename');
          if (fault === 'link') assert.equal(error.publication, null);
          if (fault === 'rename-and-close') {
            assert.equal(error.operation, 'publishEnvContent');
            assert.equal(error.phase, 'publish');
            assert.equal(error.reason, 'OS_ERROR');
            assert.ok(error.cleanupErrors.length > 0);
            assert.equal(error.published, false);
          }
          assert.doesNotMatch(JSON.stringify(error), /synthetic-secret-must-not-escape/);
          assert.equal(faultFired, true, fault + ' fault injection fired on the intended filesystem operation');
          return true;
        });
        if (fault === 'rename' || fault === 'rename-and-close' || fault === 'open' || fault === 'fchown' || fault === 'fchmod' || fault === 'write' || fault === 'file-fsync' || fault === 'stage-close') {
          assert.deepEqual(fs.readFileSync(fx.envFile), oldBytes);
        } else if (fault === 'link') {
          assert.equal(fs.existsSync(fx.envFile), false);
        } else if (fault === 'private-unlink') {
          assert.deepEqual(fs.readFileSync(fx.envFile), Buffer.from('MANAGED=new-value\n'));
          assert.equal(fs.statSync(fx.envFile).nlink, 2);
        } else {
          assert.deepEqual(fs.readFileSync(fx.envFile), Buffer.from('OLD=complete\nMANAGED=new-value\n'));
        }
      } finally { clean(fx); }
    }
    const combine = fixture();
    fs.writeFileSync(combine.envFile, 'OLD=complete\n', { mode: 0o600 });
    try {
      let failed = false;
      const injected = new Proxy(fs, { get(target, key) {
        if (key === 'renameSync') return () => { throw syntheticError('EIO'); };
        if (key === 'closeSync') return fd => {
          const st = target.fstatSync(fd); const name = target.readlinkSync('/proc/self/fd/' + fd);
          target.closeSync(fd);
          if (!failed && st.isDirectory() && path.resolve(name) === path.dirname(combine.envFile)) { failed = true; throw syntheticError('EIO'); }
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      }});
      assert.throws(() => hooks(combine, { fs: injected }).api.writeEnvFile({ MANAGED: 'new' }), error => {
        credentialError(error); assert.equal(error.operation, 'publishEnvContent'); assert.equal(error.phase, 'publish');
        assert.ok(error.cleanupErrors.length); assert.equal(error.published, false); return true;
      });
      assert.equal(failed, true, 'combined cleanup close fault fired');
    } finally { clean(combine); }
    const nonCredential = fixture();
    try {
      let failed = false;
      const injected = new Proxy(fs, { get(target, key) {
        if (key === 'closeSync') return fd => {
          const st = target.fstatSync(fd); const name = target.readlinkSync('/proc/self/fd/' + fd); target.closeSync(fd);
          if (!failed && st.isDirectory() && path.resolve(name) === path.dirname(nonCredential.envFile)) { failed = true; throw syntheticError('EIO'); }
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      }});
      assert.throws(() => hooks(nonCredential, {
        fs: injected,
        console: { log() { throw new Error('non-credential synthetic'); }, error() {}, warn() {} }
      }).api.writeEnvFile({ MANAGED: 'new' }), error => {
        credentialError(error); assert.equal(error.reason, 'OS_ERROR'); assert.equal(error.published, true);
        assert.ok(error.cleanupErrors.some(entry => entry.reason === 'NON_CREDENTIAL_FAILURE')); return true;
      });
      assert.equal(failed, true, 'non-credential cleanup close fault fired');
    } finally { clean(nonCredential); }
    const invalidText = fixture(); const invalidRaw = Buffer.from('RAW=whole\n');
    fs.writeFileSync(invalidText.envFile, invalidRaw, { mode: 0o600 });
    try {
      assert.throws(() => hooks(invalidText).api.writeEnvFile({ MANAGED: '\ud800' }), error => {
        credentialError(error); assert.equal(error.reason, 'NON_LOSSLESS_UTF8'); assert.equal(error.phase, 'encode'); return true;
      });
      assert.deepEqual(fs.readFileSync(invalidText.envFile), invalidRaw);
    } finally { clean(invalidText); }
    const fx = fixture();
    try { assert.throws(() => hooks(fx).api.decodeEnvUtf8(Buffer.from([0xe9])), credentialError); }
    finally { clean(fx); }
  });
  test('T9 interruption', async () => {
    const fx = fixture();
    try {
      const original = Buffer.from('OLD=whole\n');
      fs.writeFileSync(fx.envFile, original, { mode: 0o600 });
      fs.writeFileSync(fx.backup, original, { mode: 0o600 });
      const runner = path.join(fx.dir, 'publisher-child.cjs');
      fs.writeFileSync(runner, [
        "const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');",
        "const sourcePath=process.argv[2],target=process.argv[3],mode=process.argv[4],marker=process.argv[5];",
        "let source=fs.readFileSync(sourcePath,'utf8').replace(/^#!.*\\n/,'');",
        "source=source.replace(/\\nrun\\(process\\.argv\\.slice\\(2\\)\\)\\.catch\\([\\s\\S]*?\\);\\s*$/,'\\nmodule.exports.__child={writeEnvFile,backupEnvFile,secureEnvFiles};\\n');",
        "const pause=()=>{fs.writeFileSync(marker,'paused');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);};",
        "const injectedFs=new Proxy(fs,{get(o,k){if(k==='renameSync'&&mode.startsWith('rename-'))return(...a)=>{if(mode==='rename-before')pause();const r=o.renameSync(...a);if(mode==='rename-after')pause();return r;};if(k==='linkSync'&&mode==='link-after')return(...a)=>{const r=o.linkSync(...a);pause();return r;};const v=o[k];return typeof v==='function'?v.bind(o):v;}});",
        "const fakeProcess={env:{...process.env,ENV_FILE:target},argv:['node',sourcePath],platform:process.platform,getuid:()=>process.getuid(),geteuid:()=>process.geteuid(),exit:c=>process.exit(c)};",
        "const fakeModule={exports:{}},fakeRequire=n=>n==='fs'?injectedFs:n==='path'?path:n==='child_process'?cp:require(n);fakeRequire.main=fakeModule;",
        "new Function('require','module','exports','__dirname','__filename','process','console',source)(fakeRequire,fakeModule,fakeModule.exports,path.dirname(sourcePath),sourcePath,fakeProcess,console);",
        "const api=fakeModule.exports.__child;if(mode.startsWith('rename-'))api.writeEnvFile({MANAGED:'NEW=complete'});else api.backupEnvFile();"
      ].join('\n'));
      const interrupt = async mode => {
        const marker = path.join(fx.dir, 'pause-' + mode);
        const child = cp.spawn(process.execPath, [runner, SOURCE, fx.envFile, mode, marker], {
          stdio: 'ignore', env: { PATH: '/usr/bin:/bin' }
        });
        const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
        const boundedClose = () => new Promise(resolve => {
          const timer = setTimeout(() => resolve(null), 5000);
          closed.then(result => { clearTimeout(timer); resolve(result); });
        });
        const killAndWait = async () => {
          child.kill('SIGKILL');
          const result = await boundedClose();
          assert.ok(result, mode + ' child close observed within 5 seconds after SIGKILL');
          return result;
        };
        const deadline = Date.now() + 7000;
        while (!fs.existsSync(marker) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        if (!fs.existsSync(marker)) {
          await killAndWait();
          assert.fail(mode + ' reached publication pause');
        }
        const result = await killAndWait();
        assert.equal(result.signal, 'SIGKILL');
      };
      await interrupt('rename-before');
      assert.deepEqual(fs.readFileSync(fx.envFile), original);
      await interrupt('rename-after');
      assert.equal(fs.readFileSync(fx.envFile, 'utf8'), 'OLD=whole\nMANAGED=NEW=complete\n');
      assert.equal(mode(fx.envFile), 0o600);
      assert.deepEqual(fs.readFileSync(fx.backup), original);
      fs.unlinkSync(fx.backup);
      fs.writeFileSync(fx.envFile, original, { mode: 0o600 });
      await interrupt('link-after');
      assert.equal(fs.statSync(fx.envFile).nlink, 1);
      assert.equal(fs.statSync(fx.backup).nlink, 2);
      const next = cli(['--secure-env-file'], fx);
      assert.equal(next.status, 74);
      assert.equal(fs.statSync(fx.backup).nlink, 2);
    } finally { clean(fx); }
  });
  test('T10 mirrors and actual runtime consumers', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/chirpstack-bootstrap.js'));
    assert.deepEqual(fs.readFileSync(CANONICAL), source); assert.deepEqual(fs.readFileSync(MIRROR), source);
    assert.deepEqual(fs.readFileSync(INIT_A), fs.readFileSync(INIT_B));
    assert.match(fs.readFileSync(INIT_A, 'utf8'), /\/usr\/share\/node-red\/chirpstack-bootstrap\.js/);
    const deploy = fs.readFileSync(DEPLOY, 'utf8');
    assert.match(deploy, /older ROM script/); assert.match(deploy, /updated \/srv\/node-red script/);
    const fx = fixture();
    const raw = 'CHIRPSTACK_APP_SENSORS=app-from-env\nDEVICE_EUI=stale-identity\n';
    fs.writeFileSync(fx.envFile, raw);
    const settingsCopy = fs.readFileSync(SETTINGS_JS, 'utf8').replace("const chirpstackEnvPath = '/srv/node-red/.chirpstack.env';", 'const chirpstackEnvPath = ' + JSON.stringify(fx.envFile) + ';');
    assert.notEqual(settingsCopy, fs.readFileSync(SETTINGS_JS, 'utf8'), 'consumer path was fixture redirected');
    const settingsRun = cp.spawnSync(process.execPath, ['-e', "process.env.DEVICE_EUI='current-identity'; require('vm').runInThisContext(" + JSON.stringify(settingsCopy) + "); process.stdout.write(JSON.stringify({app:process.env.CHIRPSTACK_APP_SENSORS,eui:process.env.DEVICE_EUI}));"], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(settingsRun.status, 0, settingsRun.stderr);
    assert.deepEqual(JSON.parse(settingsRun.stdout), { app: 'app-from-env', eui: 'current-identity' });
    const initSource = fs.readFileSync(NODE_RED_INIT, 'utf8');
    const match = initSource.match(/load_chirpstack_env_value\(\) \{[\s\S]*?^\}/m);
    assert.ok(match, 'actual node-red.init per-key parser extracted');
    const initRun = cp.spawnSync('/bin/sh', ['-c', 'CHIRPSTACK_ENV_FILE=' + JSON.stringify(fx.envFile) + '\n' + match[0] + '\nload_chirpstack_env_value CHIRPSTACK_APP_SENSORS'], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(initRun.status, 0, initRun.stderr);
    assert.equal(initRun.stdout, 'app-from-env\n');
    clean(fx);
  });
}
