'use strict';

// Task4b guard: keep the reviewed STREGA writer inventory attached to the runtime
// flow while the actual adapter tests exercise the shared dispatch core.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const profilePaths = [
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'),
];
const liveWrappers = require(path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/live-wrappers'));
const extractedAdapters = {
  'delete-device-valve-cleanup-fn': ['liveDeleteValveCleanup', /clearValveOnUnclaim/],
  'cdbaa3891d40d7a1': ['liveEncoder', /executeValveAttempt/],
  'write-strega-expectation': ['liveWriteExpectation', /function liveWriteExpectation/],
  'valve-api-router-fn': ['liveValveApiRouter', /handleHttpRequest/],
  'valve-once-fn': ['liveValveOnce', /runOnceTick/],
  'valve-clock-fn': ['liveValveClock', /runValveTick/],
  'b1bc51c1d156de8b': ['liveCloudCommand', /applyCloudCommand/],
  'strega-sql-fn': ['liveStregaSql', /observeClosedEvidence/],
};
for (const [id, [name, implementation]] of Object.entries(extractedAdapters)) {
  assert.equal(typeof liveWrappers[name], 'function', `missing extracted adapter ${name} for ${id}`);
  assert.match(liveWrappers[name].toString(), implementation, `${id} adapter implementation must perform its claimed operation`);
}

const required = {
  '244a39f37fe623c1': 'mqtt out',
  'valve-push-mqtt-out': 'mqtt out',
  '9fae49d9ba22b793': 'mqtt out',
  'delete-device-valve-mqtt-out': 'mqtt out',
  'write-strega-expectation': 'function',
  'cdbaa3891d40d7a1': 'function',
  '5974306566e99a92': 'link in',
  'e64341bbdedbacf4': 'link in',
};

// Exhaustive runtime inventory: every function node that can enqueue a STREGA
// frame or flush its queue must resolve the shared osi-valve-control wrapper.
const requiredWriterCallers = [
  'delete-device-valve-cleanup-fn', 'cdbaa3891d40d7a1',
  'cancel-strega-actuation-fn', 'valve-api-router-fn', 'valve-ack-fn',
  'valve-once-fn', 'valve-clock-fn', 'b1bc51c1d156de8b', 'conditional-policy-route-fn',
];

let canonical;
for (const file of profilePaths) {
  const flow = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byId = new Map(flow.map((node) => [node.id, node]));
  const actualWriterCallers = flow.filter((node) => node.type === 'function' && /(queuePushes|enqueueValveCommand|flushValveQueue|clearValveOnUnclaim|flushDeviceQueue)/.test(node.func || '')).map((node) => node.id).sort();
  assert.deepEqual(actualWriterCallers, requiredWriterCallers.slice().sort(), `${file}: exhaustive STREGA writer/flush inventory changed`);
  for (const id of requiredWriterCallers) assert.match(byId.get(id).func, /osi-valve-control/, `${file}: ${id} must use shared valve-control wrapper`);
  const lifecycleAdapter = byId.get('conditional-lifecycle-command-adapter');
  assert.match(lifecycleAdapter.func || '', /osiLib\.require\('osi-irrigation-policy'\)/, `${file}: lifecycle command adapter must load the lifecycle service`);
  assert.match(lifecycleAdapter.func || '', /routes\.conditionalLifecycleCommand/, `${file}: lifecycle command adapter must delegate to the reviewed route implementation`);
  for (const [id, [name]] of Object.entries(extractedAdapters)) {
    assert.match(byId.get(id).func || '', new RegExp(`live\\.value\\.${name}\\b`), `${file}: ${id} must resolve ${name} from extracted implementation`);
  }
  const conditionalPolicyRoute = byId.get('conditional-policy-route-fn');
  assert.match(conditionalPolicyRoute.func, /osiLib\.require\('osi-irrigation-policy'\)/,
    `${file}: conditional policy route must load the policy API service`);
  assert.match(conditionalPolicyRoute.func, /osiLib\.require\('osi-valve-control'\)/,
    `${file}: conditional policy route must load the shared valve-control transport service`);
  assert.match(conditionalPolicyRoute.func, /policy\.value\.handleHttpRequest\(options\)/,
    `${file}: conditional policy route must delegate writes to the policy API service`);
  for (const [id, type] of Object.entries(required)) {
    assert.equal(byId.get(id) && byId.get(id).type, type, `${file}: missing or changed writer ${id}`);
  }

  const expectation = byId.get('write-strega-expectation');
  assert.match(expectation.func, /liveWriteExpectation/);
  assert.doesNotMatch(expectation.func, /reserveValveCommand\s*\(/);
  assert.doesNotMatch(expectation.func, /_stregaReservation/);

  const encoder = byId.get('cdbaa3891d40d7a1');
  assert.match(encoder.func, /executeValveAttempt/);
  assert.match(encoder.func, /withValveWriter|dispatch/);
  assert.match(encoder.func, /return \[null, logMsg, ackMsg, localResponse\]/);
  assert.doesNotMatch(encoder.func, /command\/down|mqtt out/i);

  // The shared MQTT output remains available for LSN50's mode reply, but STREGA's
  // encoder output slot is deliberately null. The three valve-only MQTT outputs are
  // retained as inert inventory nodes for old flow wiring compatibility.
  assert.equal(encoder.wires[0][1], '244a39f37fe623c1');
  assert.equal(encoder.wires[0].length, 2);
  assert.equal(encoder.func.includes("return [null, logMsg, ackMsg, localResponse]"), true);
  assert.equal(byId.get('e64341bbdedbacf4').wires[0][0], 'write-strega-expectation', `${file}: simulation must traverse expectation writer`);
  assert.match(byId.get('3301d5ea9863f66b').func, /commandType:\s*["']OPEN_FOR_DURATION/);

  if (!canonical) canonical = fs.readFileSync(file);
  else assert.deepEqual(fs.readFileSync(file), canonical, `${file}: profile parity drift`);
}

const wrapper = spawnSync(process.execPath, [path.join(__dirname, 'test-conditional-irrigation-writer-wrappers.js')], { encoding: 'utf8' });
if (wrapper.status !== 0) {
  process.stderr.write(wrapper.stdout || '');
  process.stderr.write(wrapper.stderr || '');
  process.exit(wrapper.status || 1);
}
process.stdout.write(wrapper.stdout || '');
console.log('conditional irrigation writer inventory + actual wrappers: OK');
