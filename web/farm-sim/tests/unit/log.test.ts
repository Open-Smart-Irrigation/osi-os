import assert from 'node:assert/strict';
import test from 'node:test';
import {GameLog} from '../../src/core/log';
import {createRun, loadRun} from '../../src/core/replay';
import {defaultHeader} from '../../src/core/scenario';
import {LogExport} from '../../src/ui/export';

test('core log sequences records and detaches inputs and returned batches', () => {
  const header = defaultHeader('tests');
  const log = new GameLog();
  const action = {tick: 0, seq: 1, cmd: {kind: 'move' as const, dx: 1, dy: 0}};
  log.append(header.start, 'session_start', header);
  log.append(header.start, 'command', action);
  action.cmd.dx = -1;
  const batch = log.since(1);
  assert.deepEqual(batch, [{seq: 2, sim_time: header.start, type: 'command',
    payload: {tick: 0, seq: 1, cmd: {kind: 'move', dx: 1, dy: 0}}}]);
  batch[0].seq = 999;
  assert.equal(log.since(1)[0].seq, 2);
});

test('export stamps wall offsets and one session id per export without changing core records', () => {
  const header = defaultHeader('tests');
  const log = new GameLog();
  log.append(header.start, 'session_start', header);
  log.append(header.start + 100, 'api_read', {path: '/api/devices'});
  const exporter = new LogExport(header, 20);
  exporter.receive(log.since(0).slice(0, 1), 30);
  exporter.receive(log.since(exporter.sequence), 520);

  const records = exporter.jsonl('test-export').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(row => row.wall_offset_s), [.01, .5]);
  assert.ok(records.every(row => row.session_id === 'test-export' && row.scenario === 'baseline'
    && row.seed === header.seed && row.tier === 0 && row.build === 'tests'));
  assert.notEqual(exporter.jsonl(), exporter.jsonl());
  assert.deepEqual(Object.keys(log.since(1)[0]), ['seq', 'sim_time', 'type', 'payload']);
});

test('a log exported after loading a replay marks where the rebuilt records end', () => {
  const played = createRun(defaultHeader('tests'));
  played.apply({kind: 'move', dx: 1, dy: 0});
  played.step(100);
  const run = loadRun(played.save());
  const rebuilt = run.eventsSince(0);
  const loadedAt = run.now;
  const exporter = new LogExport(run.header, 1_000);
  exporter.replayLoad(rebuilt, loadedAt, 1_250);
  assert.equal(exporter.sequence, rebuilt.length);
  run.apply({kind: 'move', dx: 0, dy: 1});
  run.step(0);
  exporter.receive(run.eventsSince(exporter.sequence), 4_000);

  const records = exporter.jsonl('test-export').trim().split('\n').map(line => JSON.parse(line));
  const marker = records.findIndex(row => row.type === 'replay_load');
  assert.equal(marker, rebuilt.length);
  assert.equal(records.filter(row => row.type === 'replay_load').length, 1);
  assert.deepEqual(records[marker], {sim_time: loadedAt, type: 'replay_load',
    payload: {last_replayed_seq: rebuilt.length}, wall_offset_s: .25, session_id: 'test-export',
    scenario: 'baseline', seed: run.header.seed, build: 'tests', tier: 0});
  const core = records.filter(row => row.type !== 'replay_load');
  assert.deepEqual(core.map(row => row.seq), Array.from({length: rebuilt.length + 1}, (_, index) => index + 1));
  assert.deepEqual(records.slice(marker + 1).map(row => [row.type, row.wall_offset_s]), [['command', 3]]);

  const live = new LogExport(played.header, 0);
  live.receive(played.eventsSince(0), 10);
  assert.ok(!live.jsonl().includes('replay_load'));
});
