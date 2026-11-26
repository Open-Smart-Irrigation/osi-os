import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {SCENARIOS} from '../src/core/scenario';
import {round2} from '../src/core/units';
import {generateGolden} from '../tests/integration/reference-run';

function writeAndDiff(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', path], {stdio: 'ignore'});
  const args = tracked.status === 0 ? ['diff', '--', path] : ['diff', '--no-index', '--', '/dev/null', path];
  const diff = spawnSync('git', args, {stdio: 'inherit'});
  if (diff.error) throw diff.error;
  if (diff.status !== 0 && !(tracked.status !== 0 && diff.status === 1)) process.exitCode = diff.status ?? 1;
}

const golden = generateGolden();
// The slice report compares a T4 run with its scenario's daily timer (T3) reference run. That
// plan runs once every day, so its irrigation days are its runs that delivered water.
const timerReference = Object.fromEntries(SCENARIOS.flatMap(scenario => {
  const policy = scenario.reference.tiers.find(candidate => candidate.tier === 3);
  if (!policy) return [];
  if (policy.kind !== 'weekly-plan' || policy.weekdays !== 127) {
    throw new Error(scenario.id + ': the T3 reference is not a daily timer');
  }
  const timer = golden[scenario.id].tiers[3];
  return [[scenario.id, {
    liters: round2(timer.runLiters.reduce((sum, liters) => sum + liters, 0)),
    pumpStrokes: timer.pumpStrokes,
    carryTrips: timer.carryTrips,
    harvestedKg: timer.harvestedKg,
    stressDays: timer.stressDays,
    irrigationDays: timer.runLiters.filter(liters => liters > 0).length,
    soilWaterEndMm: timer.soilWaterMm.end,
  }] as const];
}));

writeAndDiff(fileURLToPath(new URL('../tests/integration/reference-golden.json', import.meta.url)), golden);
writeAndDiff(fileURLToPath(new URL('../src/scenarios/reference-summary.json', import.meta.url)), timerReference);
