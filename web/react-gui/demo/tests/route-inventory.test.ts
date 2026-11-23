import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import ts from 'typescript';
import {MAIN_ROUTE_DISPOSITIONS} from '../route-dispositions';
import {DemoError, Simulator, VALVE_EUI} from '../model';

test('main-added simulator routes have one explicit method, disposition, and reason', () => {
  const keys = MAIN_ROUTE_DISPOSITIONS.map(route => `${route.method} ${route.path}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(MAIN_ROUTE_DISPOSITIONS.every(route => route.reason.trim().length > 20));
});

test('each main-added route disposition is attached to a real API service caller', async () => {
  const file = resolve(import.meta.dirname, '../../src/services/api.ts');
  const source = await readFile(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const callers = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'api'
      && ['get', 'post', 'put', 'delete'].includes(node.expression.name.text) && node.arguments[0]) {
      const raw = node.arguments[0].getText(ast).replace(/^['\x60]|['\x60]$/g, '');
      callers.add(`${node.expression.name.text.toUpperCase()} ${raw.replace(/\$\{[^}]+\}/g, ':dynamic')}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const route of MAIN_ROUTE_DISPOSITIONS) {
    const routePath = route.path.replace(/:(?:zone|eui)\b/g, ':dynamic');
    assert.ok(callers.has(`${route.method} ${routePath}`), `missing service caller: ${route.method} ${route.path}`);
  }
});

test('conditional policy status and decisions are readable while enabled conditional activation fails closed', () => {
  const sim = new Simulator({mode: 'public'});
  const status = sim.request('GET', '/api/irrigation-zones/1/irrigation-policy') as Record<string, any>;
  assert.equal(status.qualification.qualified, false);
  assert.equal(status.qualification.reason, 'qualification_unavailable');
  assert.deepEqual(sim.request('GET', '/api/irrigation-zones/1/irrigation-policy/decisions'),
    {decisions: [], next_cursor: null, limit: 25});
  assert.throws(() => sim.request('PUT', '/api/irrigation-zones/1/irrigation-policy', {
    enabled: true, schedules: [{kind: 'WEEKLY', execution: 'conditional', condition_policy_uuid: 'demo-policy'}],
  }), (error: unknown) => error instanceof DemoError && error.status === 503 && error.code === 'qualification_unavailable');
});

test('policy pause, retry, and rain-source writes are unsupported while user administration stays permission-gated', () => {
  const sim = new Simulator({mode: 'public'});
  const cases: Array<[string, string, Record<string, unknown>?]> = [
    ['POST', '/api/irrigation-zones/1/irrigation-policy/pause', {}],
    ['POST', '/api/irrigation-zones/1/irrigation-policy/retry-valve', {device_eui: VALVE_EUI}],
    ['PUT', '/api/irrigation-zones/1/rain-source', {deveui: null}],
  ];
  for (const [method, path, body] of cases) {
    assert.throws(() => sim.request(method, path, body), (error: unknown) =>
      error instanceof DemoError && error.status === 501 && error.code === 'unsupported', `${method} ${path}`);
  }
  for (const [method, path, body] of [['GET', '/api/users', undefined], ['POST', '/api/users', {username: 'demo'}]] as const) {
    assert.throws(() => sim.request(method, path, body), (error: unknown) =>
      error instanceof DemoError && error.status === 403 && error.code === 'forbidden', `${method} ${path}`);
  }
});

test('rain-source read matches the gateway view without making a source selection', () => {
  const sim = new Simulator({mode: 'public'});
  const view = sim.request('GET', '/api/irrigation-zones/1/rain-source') as Record<string, any>;
  assert.deepEqual(Object.keys(view).sort(), ['basis', 'candidates', 'selected_deveui', 'state', 'suggested_deveui']);
  assert.equal(view.state, 'selected');
  assert.equal(view.basis, 'only_candidate');
  assert.equal(view.selected_deveui, '00000000000000E1');
  assert.deepEqual(view.candidates.map((candidate: Record<string, unknown>) => candidate.via), ['direct']);
  assert.equal(view.suggested_deveui, view.selected_deveui);
});
