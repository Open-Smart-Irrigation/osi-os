import {globSync, readFileSync, statSync} from 'node:fs';
import {basename, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {brotliCompressSync, constants} from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const params = {[constants.BROTLI_PARAM_QUALITY]: 11};
const files = globSync('dist/**/*', {cwd: root}).filter(file => statSync(resolve(root, file)).isFile()).sort();
const phone = files.filter(file => file.startsWith('dist/phone/'));
const game = files.filter(file => !file.startsWith('dist/phone/'));

function brotliTotal(paths) {
  return paths.reduce((total, path) =>
    total + brotliCompressSync(readFileSync(resolve(root, path)), {params}).length, 0);
}

try {
  const entries = files.filter(file => file.endsWith('.html'));
  if (entries.join(',') !== 'dist/index.html,dist/phone/phone.html') {
    throw new Error('expected dist/index.html and dist/phone/phone.html as the only HTML entries');
  }
  const {image} = JSON.parse(readFileSync(resolve(root, 'dist/generated/atlas.json'), 'utf8'));
  if (typeof image !== 'string' || basename(image) !== image || !game.includes('dist/generated/' + image)) {
    throw new Error('atlas.json does not name a generated atlas image');
  }
  const atlas = statSync(resolve(root, 'dist/generated', image)).size;
  const budgets = [
    {label: 'Atlas', bytes: atlas, limit: 130_000, unit: 'bytes'},
    {label: 'Game', bytes: brotliTotal(game), limit: 600_000, unit: 'Brotli bytes'},
    {label: 'Phone', bytes: brotliTotal(phone), limit: 900_000, unit: 'Brotli bytes'},
  ];
  for (const {label, bytes, limit, unit} of budgets) console.log(`${label}: ${bytes} ${unit} (limit ${limit})`);
  const exceeded = budgets.filter(({bytes, limit}) => bytes > limit).map(({label}) => label);
  if (exceeded.length) throw new Error('bundle budget exceeded: ' + exceeded.join(', '));
  console.log('check-budgets: OK');
} catch (error) {
  console.error('check-budgets: ' + error.message);
  process.exitCode = 1;
}
