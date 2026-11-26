import {spawnSync} from 'node:child_process';
import {existsSync, globSync, mkdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const patterns = [];
let output;
while (args.length) {
  const arg = args.shift();
  if (arg === '--out' && output === undefined && args[0] && !args[0].startsWith('-')) {
    output = args.shift();
  } else if (arg.startsWith('-')) {
    console.error('run-tests: invalid option ' + arg);
    process.exit(2);
  } else {
    patterns.push(arg);
  }
}

if (!patterns.length) {
  console.error('run-tests: no patterns given');
  process.exit(2);
}

const files = new Set();
let invalid = false;
for (const pattern of patterns) {
  const hits = globSync(pattern).filter(file => !file.split(path.sep).includes('node_modules')
    && statSync(file, {throwIfNoEntry: false})?.isFile());
  if (!hits.length) {
    console.error('run-tests: ' + pattern + ' matches no file');
    invalid = true;
  }
  for (const hit of hits.sort()) files.add(hit);
}
if (invalid) process.exit(2);

const localTsx = path.join(packageRoot, 'node_modules/.bin/tsx');
const tsx = existsSync(localTsx) ? localTsx : path.resolve(packageRoot, '../react-gui/node_modules/.bin/tsx');
const reporter = fileURLToPath(new URL('./file-reporter.mjs', import.meta.url));
const outPath = path.resolve(output ?? 'test-results/unit-files.json');
mkdirSync(path.dirname(outPath), {recursive: true});

const env = {...process.env};
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(tsx, [
  '--test', '--test-concurrency=2',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=' + reporter, '--test-reporter-destination=' + outPath,
  '--', ...files,
], {stdio: 'inherit', env});
if (result.error) console.error('run-tests: ' + result.error.message);
process.exit(result.status ?? 1);
