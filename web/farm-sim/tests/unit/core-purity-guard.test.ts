import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const guard = fileURLToPath(new URL('../../scripts/verify-core-purity.mjs', import.meta.url));

/** Allowed code that sits next to each rule: none of it may be reported. */
const CLEAN = {
  'src/core/clean.ts': [
    "import {et0} from '@osi-edge/et0.js';",
    "import {sha256} from '@noble/hashes/sha256';",
    "import {utf8ToBytes as encode} from '@noble/hashes/utils';",
    "export const digest = sha256(encode('day 3')).length;",
    'export function fetch(url: string): string { return url; }',
    'export const stamp = (ms: number): string => new Date(ms).toISOString();',
    "export const parsed = Date.parse('2027-01-11T00:00:00Z') + Date.UTC(2027, 0, 11);",
    "export const zoned = new Date('2027-01-11T00:00:00.000+03:00').getTime() + Date.parse(`2027-01-11T07:30-03:00`);",
    'export const parseText = (text: string) => Date.parse(text) + new Date(text).getTime();',
    "export const dayStart = (day: string) => Date.parse(day + 'T00:00:00Z') + new Date(Date.UTC(2027, 0, 11)).getTime();",
    'export const isDate = (value: unknown): value is Date => value instanceof Date;',
    'export const later: Date | null = null;',
    'export const dice = {random: () => 4, now: () => 5};',
    'export const four = dice.random() + dice.now() + Math.max(1, 2) + Math.floor(et0);',
    "export const read = fetch('local');",
    'export const names = {setTimeout: 1, performance: {now: 2}, process: {hrtime: 3}, crypto: {randomUUID: 4}};',
    "const crypto = {randomUUID: () => 'local'};",
    'export const id = crypto.randomUUID();',
    'export const host = {uptime: () => 6, timeOrigin: 7, getRandomValues: (bytes: number[]) => bytes};',
    'export const up = host.uptime() + host.timeOrigin + host.getRandomValues([1]).length;',
    'export const elapsed = (process: {uptime(): number}) => process.uptime();',
    'export const calendar = {Now: {instant: () => 8}};',
    'export const instant = calendar.Now.instant();',
    'export const copy = structuredClone({at: 1});',
    "export const url = new URL('/local', 'https://example.invalid');",
    'export const source = Function.prototype.toString.call(Object);',
  ].join('\n'),
  'src/core/osi/simulator.ts': [
    "import {model} from '@osi-demo/model';",
    "import type {Model} from '@osi-demo/model';",
    'export const simulator: Model = model;',
  ].join('\n'),
};

/** One file per rule; each must fail for its own rule only, on line 1. */
const NEGATIVE: Record<string, readonly [source: string, problem: string]> = {
  'math-random.ts': ['export const roll = () => Math.random();', 'nondeterministic source: Math.random'],
  'math-random-alias.ts': ['export const roll = globalThis.Math.random;', 'nondeterministic source: Math.random'],
  'date-now.ts': ['export const now = () => Date.now();', 'nondeterministic source: Date.now'],
  'date-now-destructured.ts': ['export const {now} = Date;', 'nondeterministic source: Date.now'],
  'performance-now.ts': ['export const now = () => performance.now();', 'nondeterministic source: performance.now'],
  'new-date.ts': ['export const today = () => new Date();', 'nondeterministic source: new Date() without arguments'],
  'new-date-bare.ts': ['export const today = () => new Date;', 'nondeterministic source: new Date() without arguments'],
  'date-call.ts': ['export const today = () => Date();', 'nondeterministic source: Date() call'],
  'date-member.ts': ['export const today = () => Date.call(undefined);', 'cannot classify use of Date.call'],
  'new-date-fields.ts': ['export const day = new Date(2027, 0, 11);', 'host time zone: new Date with two or more arguments'],
  'new-date-fields-global.ts': ['export const day = (year: number, month: number) => new globalThis.Date(year, month);',
    'host time zone: new Date with two or more arguments'],
  'new-date-local-string.ts': ["export const day = new Date('2027-01-11T00:00:00');",
    'host time zone: new Date string without Z or an offset'],
  'new-date-template.ts': ['export const day = new Date(`2027-01-11T00:00:00` as string);',
    'host time zone: new Date string without Z or an offset'],
  'date-parse-local-string.ts': ["export const day = Date.parse('2027-01-11T00:00:00');",
    'host time zone: Date.parse string without Z or an offset'],
  'date-parse-date-only.ts': ["export const day = globalThis.Date['parse'](('2027-01-11'));",
    'host time zone: Date.parse string without Z or an offset'],
  'eval.ts': ["export const now = () => (0, eval)('Date.now()');", 'dynamic code: eval'],
  'function-constructor.ts': ["export const now = new Function('return performance.now()');", 'dynamic code: Function'],
  'declare-global.ts': ['declare global { var Math: {random(): number}; } export const roll = () => Math.random();',
    'nondeterministic source: Math.random'],
  'set-timeout.ts': ['export const later = () => setTimeout(() => 1, 5);', 'host scheduling or network: setTimeout'],
  'set-interval.ts': ['export const tick = () => setInterval(() => 1, 5);', 'host scheduling or network: setInterval'],
  'set-immediate.ts': ['export const soon = () => setImmediate(() => 1);', 'host scheduling or network: setImmediate'],
  'queue-microtask.ts': ['export const soon = () => queueMicrotask(() => 1);', 'host scheduling or network: queueMicrotask'],
  'fetch.ts': ["export const load = () => fetch('/api/devices');", 'host scheduling or network: fetch'],
  'fetch-global.ts': ['export const {fetch} = globalThis;', 'host scheduling or network: fetch'],
  'websocket.ts': ["export const socket = new WebSocket('wss://example.invalid');", 'host scheduling or network: WebSocket'],
  'websocket-global.ts': ['export const {WebSocket} = globalThis;', 'host scheduling or network: WebSocket'],
  'process-hrtime.ts': ['export const tick = () => process.hrtime.bigint();', 'nondeterministic source: process.hrtime'],
  'process-uptime.ts': ['export const up = () => process.uptime();', 'nondeterministic source: process.uptime'],
  'process-member.ts': ['export const env = () => process.env;', 'cannot classify use of process.env'],
  'performance-time-origin.ts': ['export const origin = () => performance.timeOrigin;',
    'nondeterministic source: performance.timeOrigin'],
  'performance-member.ts': ["export const mark = () => performance.mark('step');", 'cannot classify use of performance.mark'],
  'crypto-random-values.ts': ['export const bytes = () => crypto.getRandomValues(new Uint8Array(4));',
    'nondeterministic source: crypto.getRandomValues'],
  'crypto-random-uuid.ts': ['export const id = () => crypto.randomUUID();', 'nondeterministic source: crypto.randomUUID'],
  'crypto-global.ts': ['export const id = () => globalThis.crypto.randomUUID();', 'nondeterministic source: crypto.randomUUID'],
  'crypto-subtle.ts': ["export const digest = (bytes: Uint8Array) => crypto.subtle.digest('SHA-256', bytes);",
    'nondeterministic source: crypto.subtle'],
  'temporal-now.ts': ['export const now = () => Temporal.Now.instant();', 'nondeterministic source: Temporal.Now'],
  'temporal-global.ts': ['export const now = () => globalThis.Temporal.Now.instant();', 'nondeterministic source: Temporal.Now'],
  'temporal-declared.ts': ['declare const Temporal: {Now: {instant(): unknown}}; export const now = () => Temporal.Now.instant();',
    'nondeterministic source: Temporal.Now'],
  'simulator-outside-osi.ts': ["import {model} from '@osi-demo/model'; export const m = model;",
    'simulator import outside core/osi: @osi-demo/model'],
  'node-builtin.ts': ["import {performance} from 'node:perf_hooks'; export const p = performance;",
    'Node built-in import: node:perf_hooks'],
  'dynamic-member.ts': ['export const pick = (key: string) => (Math as never)[key];', 'cannot classify dynamic access on Math'],
  'dynamic-global.ts': ['export const pick = (key: string) => globalThis[key];', 'cannot classify dynamic access on globalThis'],
  'aliased-object.ts': ['export const clock = Date;', 'cannot classify use of Date'],
  'rest-destructured.ts': ['export const {...clock} = performance;', 'cannot classify rest or computed destructuring of performance'],
  'dom-global.ts': ['export const width = () => window.innerWidth;', 'DOM global: window'],
  'ui-package.ts': ["import {h} from 'preact'; export const node = h;", 'UI package import: preact'],
  'noble-crypto.ts': ["import {crypto} from '@noble/hashes/crypto'; export const id = () => crypto.randomUUID();",
    'cannot classify import: @noble/hashes/crypto'],
  'noble-random-bytes.ts': ["import {randomBytes} from '@noble/hashes/utils'; export const r = () => randomBytes(4);",
    'cannot classify import: @noble/hashes/utils'],
  'noble-renamed.ts': ["import {randomBytes as utf8ToBytes} from '@noble/hashes/utils'; export const r = utf8ToBytes;",
    'cannot classify import: @noble/hashes/utils'],
  'noble-namespace.ts': ["import * as u from '@noble/hashes/utils'; export const r = () => u.randomBytes(4);",
    'cannot classify import: @noble/hashes/utils'],
  'noble-re-export.ts': ["import {utf8ToBytes} from '@noble/hashes/utils'; export * from '@noble/hashes/utils';",
    'cannot classify import: @noble/hashes/utils'],
  'leaves-core.ts': ["import {view} from '../view/view'; export const v = view;", 'core import leaves core and scenarios: ../view/view'],
};

test('the core purity guard fails each rule on its own fixture and passes allowed code', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'farm-sim-purity-'));
  try {
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(fixture, file)), {recursive: true});
      writeFileSync(join(fixture, file), text + '\n');
    };
    const run = () => spawnSync(process.execPath, [guard, '--root', fixture], {encoding: 'utf8'});
    write('package.json', JSON.stringify({dependencies: {'@noble/hashes': '1.8.0'}}));
    write('tsconfig.json', JSON.stringify({compilerOptions: {paths: {'@osi-demo/*': ['demo/*'], '@osi-edge/*': ['edge/*']}}}));
    write('demo/model.ts', 'export const model = 1;\nexport type Model = number;');
    write('edge/et0.js', 'export const et0 = 4.2;');
    write('src/view/view.ts', 'export const view = 1;');
    for (const [file, text] of Object.entries(CLEAN)) write(file, text);

    const clean = run();
    assert.equal(clean.status, 0, clean.stderr + clean.stdout);
    assert.match(clean.stdout, /verify-core-purity: OK \(2 core sources\)/);

    for (const [file, [source]] of Object.entries(NEGATIVE)) write('src/core/' + file, source);
    const failed = run();
    assert.equal(failed.status, 1, failed.stderr + failed.stdout);
    const reported = new Map<string, string[]>();
    for (const line of failed.stderr.trim().split('\n')) {
      const match = /^src\/core\/([^:]+):1: (.+)$/.exec(line);
      const file = match?.[1] ?? '(unparsed)';
      const problem = match?.[2] ?? line;
      reported.set(file, [...reported.get(file) ?? [], problem]);
    }
    assert.deepEqual(Object.fromEntries(reported),
      Object.fromEntries(Object.entries(NEGATIVE).map(([file, [, problem]]) => [file, [problem]])));
  } finally {
    rmSync(fixture, {recursive: true, force: true});
  }
});
