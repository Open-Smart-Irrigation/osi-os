'use strict';
// The dispatch-inventory verifier: negative controls on an in-memory repo, and
// the committed inventory, which may fail only on checks marked open.
const test = require('node:test'), assert = require('node:assert');
const fs = require('node:fs'), path = require('node:path');
const { verify, markdown, applyFixes, repoIO, INVENTORY, MARKDOWN } = require('../verify-dispatch-inventory');
const { scan, stripGoComments } = require('../lib/dispatch-scan');

const ROOT = path.resolve(__dirname, '../../..');

// ---- In-memory repository ------------------------------------------------

const GO_ROUTES = `package main

func init() {
	register("POST", "/api/valve/:deveui", (*backend).commandValve)
	registerTimer("valve-once-tick", time.Minute, 0, (*backend).onceTick)
	registerUplink("strega", (*backend).ingestSTREGA)
	// register("POST", "/api/ghost", (*backend).ghost)
}

func (b *backend) commandValve(w http.ResponseWriter, r *http.Request) {
	if !validEUI(r) {
		return
	}
	b.dispatch(r.Context(), "A840410000000001")
}

func (b *backend) onceTick(ctx context.Context) error {
	b.dispatch(ctx, "A840410000000002")
	return nil
}

func (b *backend) ingestSTREGA(ctx context.Context, u ingest.Uplink) error {
	_, err := b.db.ExecContext(ctx, \`UPDATE devices SET current_state=? WHERE deveui=?\`, "OPEN", u.EUI)
	return err
}

func (b *backend) ghost() {
	b.radio.Delete(ctx, &api.DeleteDeviceRequest{DevEui: "X"})
}

func (b *backend) dispatch(ctx context.Context, eui string) {
	b.radio.Enqueue(ctx, &api.EnqueueDeviceQueueItemRequest{})
}

func validEUI(r *http.Request) bool {
	return len(r.URL.Path) > 0
}
`;
const SCHEMA = `CREATE TRIGGER trg_sync_devices_outbox_au AFTER UPDATE ON devices FOR EACH ROW BEGIN
  INSERT INTO sync_outbox(event_uuid) VALUES ('x');
END;
`;
const JS = `function normalizeDevice(eui) {
  if (!/^[0-9A-F]{16}$/.test(eui)) throw new Error('invalid_device_eui');
}
function onceWorker() {
  return dispatchDue();
}
function stregaUplink() {
  return writeObservation();
}
`;
const SCENARIO = JSON.stringify({ name: 'probe', steps: [{ id: 'open', http: { method: 'POST', path: '/api/valve/A840410000000001' } }, { id: 'tick', timer: 'valve-once-tick' }, { id: 'up', uplink: {} }] });

function fakeRepo(overrides = {}) {
  const files = {
    'edge/go/cmd/osi-edge/routes.go': GO_ROUTES,
    'database/seed-blank.sql': SCHEMA,
    'conf/x/dispatch.js': JS,
    'edge/harness/scenarios/probe.json': SCENARIO,
    ...overrides,
  };
  return {
    files,
    read: (p) => { if (!(p in files)) throw new Error('ENOENT ' + p); return files[p]; },
    exists: (p) => p in files,
    goFiles: () => Object.keys(files).filter((f) => f.startsWith('edge/go/') && f.endsWith('.go') && !f.endsWith('_test.go')).sort(),
  };
}

const check = (over = {}) => ({
  id: 'hex', what: 'deveui is 16 hex', js: 'conf/x/dispatch.js:2', jsExcerpt: "if (!/^[0-9A-F]{16}$/.test(eui))",
  go: 'edge/go/cmd/osi-edge/routes.go:11', goExcerpt: 'if !validEUI(r) {', order: 1, probe: 'edge/harness/scenarios/probe.json#open', status: 'ok', ...over,
});
function fakeInventory() {
  return {
    entries: [
      { id: 'manual', entry: { kind: 'http', name: 'POST /api/valve/:deveui', go: 'edge/go/cmd/osi-edge/routes.go:10', goExcerpt: 'func (b *backend) commandValve(' }, effects: ['enqueue'], checks: [check()] },
      { id: 'once', entry: { kind: 'timer', name: 'valve-once-tick', go: 'edge/go/cmd/osi-edge/routes.go:17', goExcerpt: 'func (b *backend) onceTick(' }, effects: ['enqueue'],
        checks: [check({ id: 'due', js: 'conf/x/dispatch.js:5', jsExcerpt: 'return dispatchDue();', go: 'edge/go/cmd/osi-edge/routes.go:18', goExcerpt: 'b.dispatch(ctx, "A840410000000002")', probe: 'edge/harness/scenarios/probe.json#tick' })] },
      { id: 'strega', entry: { kind: 'uplink', name: 'strega', go: 'edge/go/cmd/osi-edge/routes.go:22', goExcerpt: 'func (b *backend) ingestSTREGA(' }, effects: ['outbox', 'valve-state'],
        checks: [check({ id: 'obs', js: 'conf/x/dispatch.js:8', jsExcerpt: 'return writeObservation();', go: 'edge/go/cmd/osi-edge/routes.go:23', goExcerpt: '_, err := b.db.ExecContext(ctx, `UPDATE devices', probe: 'edge/harness/scenarios/probe.json#up' })] },
    ],
  };
}
const run = (inv = fakeInventory(), repo = fakeRepo()) => verify({ inventory: inv, io: repo, canary: false });
const problems = (r) => r.failures.map((f) => `${f.where}: ${f.problem}`).join('\n');

test('a complete inventory on the fixture repo passes', () => {
  const r = run();
  assert.deepStrictEqual(r.failures, [], problems(r));
  assert.strictEqual(r.counts.ok, 3);
});

test('the scan finds the three entry points and ignores the commented registration', () => {
  const repo = fakeRepo();
  const s = scan(repo.goFiles().map((f) => ({ file: f, text: repo.read(f) })), SCHEMA, [], { canary: false });
  const names = s.entries.filter((e) => e.kind !== 'startup').map((e) => `${e.kind} ${e.name}`).sort();
  assert.deepStrictEqual(names, ['http POST /api/valve/:deveui', 'timer valve-once-tick', 'uplink strega']);
  const manual = s.entries.find((e) => e.kind === 'http');
  assert.deepStrictEqual(Object.keys(manual.effects), ['enqueue']);
  assert.deepStrictEqual(manual.effects.enqueue.chain, ['(backend).commandValve', '(backend).dispatch']);
  assert.ok(s.entries.find((e) => e.kind === 'uplink').effects.outbox, 'UPDATE devices fires the outbox trigger');
});

test('a check with go null fails', () => {
  const inv = fakeInventory();
  inv.entries[0].checks[0].go = null;
  assert.match(problems(run(inv)), /manual\/hex: go is null/);
});

test('a check with probe null, a missing probe file or a missing step fails', () => {
  for (const [probe, re] of [[null, /probe is null/], ['edge/harness/scenarios/none.json#open', /probe file .* does not exist/], ['edge/harness/scenarios/probe.json#nope', /probe step "nope"/]]) {
    const inv = fakeInventory();
    inv.entries[0].checks[0].probe = probe;
    assert.match(problems(run(inv)), re);
  }
});

test('a check with status open fails and is counted', () => {
  const inv = fakeInventory();
  Object.assign(inv.entries[0].checks[0], { status: 'open', finding: 'B1' });
  const r = run(inv);
  assert.match(problems(r), /status open \(B1\)/);
  assert.strictEqual(r.counts.open, 1);
});

test('a missing file, a line past the end and a missing excerpt fail', () => {
  for (const [js, re] of [['conf/x/gone.js:2', /does not exist/], ['conf/x/dispatch.js:99', /has only/]]) {
    const inv = fakeInventory();
    inv.entries[0].checks[0].js = js;
    assert.match(problems(run(inv)), re);
  }
  const inv = fakeInventory();
  inv.entries[0].checks[0].jsExcerpt = 'not in the file';
  assert.match(problems(run(inv)), /excerpt .* not found/);
});

test('an excerpt that is not unique fails', () => {
  const inv = fakeInventory();
  inv.entries[0].checks[0].goExcerpt = 'return';
  assert.match(problems(run(inv)), /occurs \d+ times/);
});

test('a moved anchor fails, and --fix-lines moves the reference to it', () => {
  const repo = fakeRepo({ 'conf/x/dispatch.js': '// a new first line\n' + JS });
  const inv = fakeInventory();
  const r = run(inv, repo);
  assert.match(problems(r), /excerpt is now at line 3 \(run --fix-lines\)/);
  applyFixes(r.fixes);
  assert.strictEqual(inv.entries[0].checks[0].js, 'conf/x/dispatch.js:3');
  assert.deepStrictEqual(run(inv, repo).failures, []);
});

test('a Go entry point of each kind without an entry fails', () => {
  for (const [i, re] of [[0, /http POST \/api\/valve\/:deveui: reaches enqueue .* via \(backend\)\.commandValve > \(backend\)\.dispatch/], [1, /timer valve-once-tick: reaches enqueue/], [2, /uplink strega: reaches outbox/]]) {
    const inv = fakeInventory();
    inv.entries.splice(i, 1);
    assert.match(problems(run(inv)), re);
  }
});

test('an entry that claims a sink effect the scan cannot reach fails', () => {
  const inv = fakeInventory();
  inv.entries[1].effects.push('cloud-mqtt');
  assert.match(problems(run(inv)), /lists effect cloud-mqtt, but the scan finds no path/);
});

test('an entry for a route the Go code no longer registers fails', () => {
  const inv = fakeInventory();
  inv.entries[0].entry.name = 'POST /api/valve/:deveui/old';
  assert.match(problems(run(inv)), /no Go http entry point "POST \/api\/valve\/:deveui\/old"/);
});

test('an unclassified ChirpStack write fails the scan; reads do not', () => {
  const extra = '\nfunc (b *backend) other(ctx context.Context) {\n\tb.radio.Activate(ctx, &api.ActivateDeviceRequest{})\n\tb.radio.Get(ctx, &api.GetDeviceRequest{})\n}\n';
  const r = run(fakeInventory(), fakeRepo({ 'edge/go/cmd/osi-edge/routes.go': GO_ROUTES + extra }));
  assert.match(problems(r), /unclassified ChirpStack request api\.ActivateDeviceRequest/);
  assert.doesNotMatch(problems(r), /GetDeviceRequest/);
});

test('the canary fails when a sink class matches no Go site', () => {
  const repo = fakeRepo();
  const r = verify({ inventory: fakeInventory(), io: repo, canary: true });
  assert.match(problems(r), /canary: sink class cloud-mqtt matched no Go site/);
});

test('a registration the parser cannot read fails the scan', () => {
  const src = GO_ROUTES.replace('registerUplink("strega", (*backend).ingestSTREGA)', 'registerUplink(\n\t\t"strega", (*backend).ingestSTREGA)');
  const r = run(fakeInventory(), fakeRepo({ 'edge/go/cmd/osi-edge/routes.go': src }));
  assert.match(problems(r), /registration call registerUplink\(\.\.\.\) did not parse/);
});

test('a sink outside any function body fails the scan', () => {
  const extra = '\nvar startupPublish = b.cloud.Publish("devices/x/status", nil)\n';
  const r = run(fakeInventory(), fakeRepo({ 'edge/go/cmd/osi-edge/routes.go': GO_ROUTES + extra }));
  assert.match(problems(r), /sink site\(s\) in the file but .* inside function bodies/);
});

test('an awaited cloud publish is a cloud-mqtt sink', () => {
  const src = 'package main\n\nfunc (b *backend) h() {\n\tb.cloud.PublishAwait(ctx, "devices/x/command_ack", nil)\n}\n\nfunc init() {\n\tregister("POST", "/x", (*backend).h)\n}\n';
  const s = scan([{ file: 'edge/go/cmd/osi-edge/a.go', text: src }], '', [], { canary: false });
  assert.deepStrictEqual(Object.keys(s.entries.find((e) => e.kind === 'http').effects), ['cloud-mqtt']);
});

test('ServeHTTP is an entry point, so a direct dispatch from it needs an entry', () => {
  const extra = '\nfunc (b *backend) ServeHTTP(w http.ResponseWriter, r *http.Request) {\n\tif r.URL.Path == "/__test/open" {\n\t\tb.dispatch(r.Context(), "A840410000000003")\n\t}\n}\n';
  const r = run(fakeInventory(), fakeRepo({ 'edge/go/cmd/osi-edge/routes.go': GO_ROUTES + extra }));
  assert.match(problems(r), /http ServeHTTP: reaches enqueue/);
});

test('a local variable named like a package function is not a call edge', () => {
  const src = 'package main\n\nfunc run() {\n\tos.WriteFile("x", nil, 0)\n}\n\nfunc (b *backend) h(run string) {\n\tuse(run)\n}\n\nfunc init() {\n\tregister("GET", "/x", (*backend).h)\n}\n';
  const s = scan([{ file: 'edge/go/cmd/osi-edge/a.go', text: src }], '', [], { canary: false });
  assert.deepStrictEqual(s.entries.find((e) => e.kind === 'http').effects, {});
});

test('comment stripping keeps line numbers and string contents', () => {
  const src = 'a // b\n/* c\nd */ e "//f" `/*g*/`\n';
  const out = stripGoComments(src);
  assert.strictEqual(out.split('\n').length, src.split('\n').length);
  assert.match(out, /"\/\/f" `\/\*g\*\/`/);
  assert.doesNotMatch(out, /\bb\b|\bc\b|\bd\b/);
});

// ---- The committed inventory ----------------------------------------------

test('the committed inventory fails only on checks marked open', () => {
  const io = repoIO(ROOT);
  const inventory = JSON.parse(io.read(INVENTORY));
  const r = verify({ inventory, io });
  const openIds = new Set();
  for (const e of inventory.entries) for (const c of e.checks) if (c.status === 'open') openIds.add(`${e.id}/${c.id}`);
  // Only the three blocking markers are waived on an open check; a broken
  // reference or probe on an open check still fails.
  const waived = /^(status open|go is null|probe is null)/;
  const other = r.failures.filter((f) => !(openIds.has(f.where) && waived.test(f.problem)));
  assert.deepStrictEqual(other, [], problems({ failures: other }));
  assert.ok(r.counts.checks >= 100, 'inventory keeps its checks');
});

test('the committed DISPATCH-INVENTORY.md matches --markdown', () => {
  const io = repoIO(ROOT);
  const inventory = JSON.parse(io.read(INVENTORY));
  const expected = markdown(inventory, verify({ inventory, io })) + '\n';
  assert.strictEqual(fs.readFileSync(path.join(ROOT, MARKDOWN), 'utf8'), expected, 'regenerate with: node edge/harness/verify-dispatch-inventory.js --write-markdown');
});
