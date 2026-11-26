import {isUtf8} from 'node:buffer';
import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const files = execFileSync('git', ['ls-files', '-z', '--', '.'], {cwd: packageRoot, encoding: 'utf8'}).split('\0').filter(Boolean);
const inputs = [];
for (const file of files) {
  if (/^art\/sprites\/.+\.[cm]?[jt]sx?$/.test(file)) continue;
  const contents = readFileSync(resolve(packageRoot, file));
  if (!contents.includes(0) && isUtf8(contents)) inputs.push(file + '\n' + contents.toString('utf8'));
}
if (!inputs.length) throw new Error('verify-package-hygiene: no tracked text files');

const scan = spawnSync(process.execPath, ['scripts/verify-doc-hygiene.js', '--stdin'], {
  cwd: root,
  // The scanner reads OSI_DOC_HYGIENE_TERMS from the inherited environment.
  input: inputs.join('\n'),
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (scan.error) throw scan.error;
process.exitCode = scan.status ?? 1;
if (process.exitCode === 0) console.log(`verify-package-hygiene: OK (${inputs.length} tracked text files)`);
