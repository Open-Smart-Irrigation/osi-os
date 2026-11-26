import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packagePath = 'web/farm-sim/**';
const workflow = '.github/workflows/farm-sim.yml';
const inventory = 'scripts/verify-test-inventory.json';
const exclusions = [':!' + packagePath, ':!' + workflow, ':!' + inventory];
const targets = new Set();

const paths = execFileSync('git', ['ls-files', '-z', '--', ':(glob)**/*farm-sim*', ':(glob)**/*farm-sim*/**', ...exclusions], {cwd: root, encoding: 'utf8'});
for (const path of paths.split('\0')) if (path.includes('farm-sim')) targets.add(path);

const matches = spawnSync('git', ['grep', '-a', '-l', '-z', '-F', 'farm-sim', '--', '.', ...exclusions], {
  cwd: root, encoding: 'utf8',
});
if (matches.status !== 0 && matches.status !== 1) throw matches.error ?? new Error(matches.stderr);
for (const path of matches.stdout.split('\0').filter(Boolean)) targets.add(path);

const {excluded, ...otherEntries} = JSON.parse(readFileSync(resolve(root, inventory), 'utf8'));
const allowed = excluded.filter(entry => entry.pattern === packagePath);
const remaining = excluded.filter(entry => entry.pattern !== packagePath);
if (allowed.length > 1 || JSON.stringify({excluded: remaining, ...otherEntries}).includes('farm-sim')) {
  targets.add(inventory);
}

if (targets.size) {
  for (const path of [...targets].sort()) console.error('verify-isolation: farm-sim reference outside the package: ' + path);
  process.exitCode = 1;
} else {
  console.log('verify-isolation: OK');
}
