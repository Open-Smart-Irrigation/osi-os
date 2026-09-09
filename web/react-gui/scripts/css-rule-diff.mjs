#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { ALLOW, diffAtoms } from './css-rule-diff-lib.mjs';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: css-rule-diff.mjs <before.css> <after.css>');
  process.exit(2);
}
const changed = diffAtoms(fs.readFileSync(beforePath, 'utf8'), fs.readFileSync(afterPath, 'utf8'));
const offenders = changed.filter((atom) => !ALLOW.test(atom));
if (offenders.length > 0) {
  console.error('css-rule-diff: unexpected CSS drift:');
  for (const atom of offenders) console.error(`  ${atom.slice(0, 200)}`);
  process.exit(1);
}
console.log(`css-rule-diff: OK (${changed.length} allowlisted atom changes)`);
