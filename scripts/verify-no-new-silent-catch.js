#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'fixtures', 'silent-catch-baseline.json');

// A catch body is "silent" if it contains nothing but whitespace, bare
// semicolons, and/or comments (line or block) -- i.e. nothing that could
// possibly surface the error. This deliberately covers evasion forms like
// `catch(e){ /* ignore */ }`, `catch(e){;}`, and `catch({message}){}` in
// addition to the truly-empty `catch(){}` / `catch{}` / `catch(e){}`.
const EMPTY_BODY_INNER = String.raw`(?:\s|;|//[^\n]*|/\*[\s\S]*?\*/)*`;

// try/catch: `catch`, an optional binding of any (non-nested-brace) content
// -- covers no binding, a simple identifier, and destructured bindings like
// `{message}` or `[a, b]` -- followed by a body that is empty per the above.
const EMPTY_TRY_CATCH_RE = new RegExp(
  String.raw`catch\s*(?:\([^)]*\))?\s*\{${EMPTY_BODY_INNER}\}`,
  'g',
);

// Promise-style `.catch(handler)` where handler is an arrow function or a
// function expression with an empty-per-the-above body, e.g.
// `.catch(() => {})`, `.catch((e) => {})`, `.catch(function(){})`,
// `.catch(function (err) { })`.
const EMPTY_PROMISE_CATCH_RE = new RegExp(
  String.raw`\.catch\s*\(\s*(?:` +
    // arrow function: (args) => { ...empty... }  or  arg => { ...empty... }
    String.raw`(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{${EMPTY_BODY_INNER}\}` +
    String.raw`|` +
    // function expression: function(args) { ...empty... }
    String.raw`function\s*[A-Za-z_$][\w$]*?\s*\([^)]*\)\s*\{${EMPTY_BODY_INNER}\}` +
    String.raw`)\s*\)`,
  'g',
);

function countMatches(source, regex) {
  const matches = source.match(regex);
  return matches ? matches.length : 0;
}

function countSilentCatchesInSource(source) {
  if (typeof source !== 'string' || source.length === 0) {
    return 0;
  }
  return countMatches(source, EMPTY_TRY_CATCH_RE) + countMatches(source, EMPTY_PROMISE_CATCH_RE);
}

const SCANNED_FUNCTION_FIELDS = ['func', 'initialize', 'finalize'];

function countSilentCatchesInFlow(flow) {
  let functionNodeCount = 0;
  let silentCatchCount = 0;

  for (const node of flow) {
    if (!node || node.type !== 'function' || typeof node.func !== 'string') {
      continue;
    }

    functionNodeCount += 1;
    for (const field of SCANNED_FUNCTION_FIELDS) {
      silentCatchCount += countSilentCatchesInSource(node[field]);
    }
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
