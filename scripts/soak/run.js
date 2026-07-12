#!/usr/bin/env node
'use strict';
const path = require('node:path');
const ARTIFACTS = path.join(__dirname, 'artifacts');

async function main() {
  const scenario = process.argv[2];
  const rest = process.argv.slice(3);
  let result;
  switch (scenario) {
    case 'outbox-replay':
      result = await require('./scenario-outbox-replay').run({ artifactDir: ARTIFACTS });
      break;
    case 'clock-jump':
      result = await require('./scenario-clock-jump').run({ artifactDir: ARTIFACTS });
      break;
    case 'kill9-migration':
      result = await require('./scenario-kill9-migration').run({ artifactDir: ARTIFACTS });
      break;
    case 'sd-full':
      result = await require('./scenario-sd-full').run({ dbPath: rest[0], artifactDir: ARTIFACTS });
      break;
    default:
      console.error('usage: run.js <outbox-replay|clock-jump|kill9-migration|sd-full> [args]');
      process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.outcome === 'pass' ? 0 : 1);
}

main().catch((e) => { console.error(`[soak] ERROR: ${e.message}`); process.exit(2); });
