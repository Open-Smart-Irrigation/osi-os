#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'fixtures', 'silent-catch-baseline.json');
const EMPTY_CATCH_RE = /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/g;

function countSilentCatchesInFlow(flow) {
  let functionNodeCount = 0;
  let silentCatchCount = 0;

  for (const node of flow) {
    if (!node || node.type !== 'function' || typeof node.func !== 'string') {
      continue;
    }

    functionNodeCount += 1;
    const matches = node.func.match(EMPTY_CATCH_RE);
    silentCatchCount += matches ? matches.length : 0;
  }

  return { functionNodeCount, silentCatchCount };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function countProfile(profileConfig) {
  const flowPath = path.join(REPO_ROOT, profileConfig.path);
  const flow = readJson(flowPath);
  return {
    path: profileConfig.path,
    ...countSilentCatchesInFlow(flow),
  };
}

function evaluateProfileCounts(liveCounts, baseline) {
  const failures = [];

  for (const [profile, profileBaseline] of Object.entries(baseline.profiles || {})) {
    const live = liveCounts[profile];
    if (!live) {
      failures.push(`${profile}: missing live count`);
      continue;
    }

    const liveCount = live.silentCatchCount;
    const baselineCount = profileBaseline.silentCatchCount;

    if (liveCount > baselineCount) {
      failures.push(`${profile}: live silent catch count ${liveCount} exceeds baseline ${baselineCount}`);
    } else if (liveCount < baselineCount) {
      failures.push(
        `${profile}: live silent catch count ${liveCount} is below baseline ${baselineCount}; update the baseline downward in this commit`,
      );
    }
  }

  return failures;
}

function countAllProfiles(baseline) {
  return Object.fromEntries(
    Object.entries(baseline.profiles || {}).map(([profile, profileConfig]) => [
      profile,
      countProfile(profileConfig),
    ]),
  );
}

function main() {
  const baseline = readJson(BASELINE_PATH);
  const liveCounts = countAllProfiles(baseline);
  const failures = evaluateProfileCounts(liveCounts, baseline);

  if (failures.length > 0) {
    console.error('verify-no-new-silent-catch: FAIL');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log('verify-no-new-silent-catch: OK');
  for (const [profile, live] of Object.entries(liveCounts)) {
    const baselineCount = baseline.profiles[profile].silentCatchCount;
    console.log(
      `- ${profile}: ${live.silentCatchCount} empty catches across ${live.functionNodeCount} function nodes (baseline ${baselineCount})`,
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  countSilentCatchesInFlow,
  evaluateProfileCounts,
};
