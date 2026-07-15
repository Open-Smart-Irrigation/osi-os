'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function loadGenerator(fileName) {
  const filePath = path.resolve(__dirname, fileName);
  const source = fs.readFileSync(filePath, 'utf8');
  if (!/if \(require\.main === module\)/.test(source)) return {};
  return require(filePath);
}

const commands = loadGenerator('migrate-flows-journal-commands.js');
const routes = loadGenerator('migrate-flows-journal-routes.js');

const flowsPath = path.resolve(
  __dirname,
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
);
const current = fs.readFileSync(flowsPath);

function mutateNode(buffer, id, field) {
  const flows = JSON.parse(buffer.toString('utf8'));
  const node = flows.find((candidate) => candidate.id === id);
  assert.ok(node, `missing fixture node ${id}`);
  if (field === 'wires') node.wires = [['review-drift']];
  else if (field === 'outputs') node.outputs = Number(node.outputs || 0) + 1;
  else if (field === 'name') node.name += ' drift';
  else throw new Error('unsupported mutation field: ' + field);
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function legacyCommandBuffer() {
  assert.equal(typeof commands.migrate, 'function');
  assert.ok(commands.LEGACY_COMMAND_SURFACES);
  const flows = JSON.parse(current.toString('utf8'));
  for (const [id, surface] of Object.entries(commands.LEGACY_COMMAND_SURFACES)) {
    const node = flows.find((candidate) => candidate.id === id);
    node.func = surface.func;
    node.libs = surface.libs;
  }
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function legacyRouteBuffer(source = routes.directThinRouterSource) {
  assert.equal(typeof routes.migrate, 'function');
  assert.equal(typeof source, 'string');
  const flows = JSON.parse(current.toString('utf8'));
  const router = flows.find((candidate) => candidate.id === 'journal-api-router-fn');
  router.func = source;
  router.libs = [
    { var: 'osiDb', module: 'osi-db-helper' },
    { var: 'osiJournal', module: 'osi-journal' },
  ];
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

test('command generator is a no-op on the exact current surface', () => {
  assert.equal(typeof commands.migrate, 'function');
  assert.equal(commands.migrate(current).equals(current), true);
});

test('command generator upgrades the exact legacy direct-helper surface', () => {
  assert.equal(commands.migrate(legacyCommandBuffer()).equals(current), true);
});

for (const state of [
  ['current', () => current],
  ['legacy', legacyCommandBuffer],
]) {
  for (const id of ['command-dedupe-dispatch', 'journal-command-apply-fn', 'command-ack-queue-rest']) {
    for (const field of ['wires', 'outputs', 'name']) {
      test(`command generator rejects ${state[0]} ${id} ${field} drift`, () => {
        assert.throws(
          () => commands.migrate(mutateNode(state[1](), id, field)),
          /Refusing non-exact journal command handler collision/,
        );
      });
    }
  }
}

test('route generator is a no-op on the exact current router surface', () => {
  assert.equal(typeof routes.migrate, 'function');
  assert.equal(routes.migrate(current).equals(current), true);
});

test('supported legacy router sources are distinct', () => {
  assert.notEqual(
    routes.LEGACY_ROUTE_SOURCES['direct-helper'],
    routes.LEGACY_ROUTE_SOURCES['pre-build-metadata'],
  );
});

for (const [label, source] of Object.entries(routes.LEGACY_ROUTE_SOURCES || {})) {
  test(`route generator upgrades the exact ${label} router surface`, () => {
    const legacy = legacyRouteBuffer(source);
    const router = JSON.parse(legacy.toString('utf8'))
      .find((candidate) => candidate.id === 'journal-api-router-fn');
    assert.equal(router.func, source, `${label} fixture did not use its requested source`);
    assert.equal(routes.migrate(legacy).equals(current), true);
  });
}

const routeStates = [['current', () => current]];
for (const [label, source] of Object.entries(routes.LEGACY_ROUTE_SOURCES || {})) {
  routeStates.push([label, () => legacyRouteBuffer(source), source]);
}
test('route generator exports both exact supported legacy router surfaces', () => {
  assert.deepEqual(Object.keys(routes.LEGACY_ROUTE_SOURCES || {}).sort(), ['direct-helper', 'pre-build-metadata']);
});
for (const state of routeStates) {
  for (const field of ['wires', 'outputs', 'name']) {
    test(`route generator rejects ${state[0]} router ${field} drift`, () => {
      const startingBuffer = state[1]();
      if (state[2]) {
        const router = JSON.parse(startingBuffer.toString('utf8'))
          .find((candidate) => candidate.id === 'journal-api-router-fn');
        assert.equal(router.func, state[2], `${state[0]} mutation fixture used the wrong source`);
      }
      assert.throws(
        () => routes.migrate(mutateNode(startingBuffer, 'journal-api-router-fn', field)),
        /Refusing non-exact journal node collision: journal-api-router-fn/,
      );
    });
  }
}
