#!/usr/bin/env node
'use strict';
// Keeps AGENTS.md readable by harnesses that inject only its first bytes.
// Codex injects the first 32,768 bytes; this check leaves a 2 KiB margin.
// It fails when the file is larger than LIMIT_BYTES, or when a required
// section heading is missing or starts past LIMIT_BYTES.
const fs = require('node:fs');
const path = require('node:path');

const LIMIT_BYTES = 30720;
const REQUIRED_HEADINGS = [
  '## Host access gate',
  '## Live-deploy safety rules',
  '## Schema and migration rules',
  '## Agent skills',
  '## Session closeout',
];

// Byte offset of the first line that equals `heading` exactly, or -1.
function headingOffset(buf, heading) {
  const text = buf.toString('utf8');
  let offset = 0;
  for (const line of text.split('\n')) {
    if (line.replace(/\r$/, '') === heading) return offset;
    offset += Buffer.byteLength(line, 'utf8') + 1;
  }
  return -1;
}

function check(buf, { limit = LIMIT_BYTES, headings = REQUIRED_HEADINGS } = {}) {
  const errors = [];
  const size = buf.length;
  if (size > limit) errors.push(`file is ${size} bytes, over the ${limit}-byte limit`);
  const found = headings.map((heading) => ({ heading, offset: headingOffset(buf, heading) }));
  for (const { heading, offset } of found) {
    if (offset < 0) errors.push(`required heading "${heading}" is missing`);
    else if (offset > limit) errors.push(`required heading "${heading}" starts at byte ${offset}, past ${limit}`);
  }
  return { size, found, errors };
}

function main(argv) {
  const fileArg = argv.find((a) => a.startsWith('--file='));
  const file = fileArg ? fileArg.slice('--file='.length) : path.join(__dirname, '..', 'AGENTS.md');
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    console.error(`verify-agents-size: cannot read ${file}: ${err.message}`);
    return 2;
  }
  const { size, found, errors } = check(buf);
  for (const { heading, offset } of found) console.log(`${String(offset).padStart(6)}  ${heading}`);
  if (errors.length) {
    for (const e of errors) console.error(`verify-agents-size: ${e}`);
    console.error('verify-agents-size: FAIL (move reference material out of AGENTS.md into a doc or skill and leave a pointer)');
    return 1;
  }
  console.log(`verify-agents-size: OK (${size} bytes, limit ${LIMIT_BYTES})`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { LIMIT_BYTES, REQUIRED_HEADINGS, headingOffset, check, main };
