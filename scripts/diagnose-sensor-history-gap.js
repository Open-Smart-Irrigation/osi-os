'use strict';

const fs = require('node:fs');

function loadRows(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function identityKey(row) {
  return `${row.deveui}|${row.recorded_at}`;
}

function compareHistories({ edgePath, cloudPath, rangeStart, rangeEnd }) {
  const inRange = (row) => row.recorded_at >= rangeStart && row.recorded_at < rangeEnd;
  const edge = loadRows(edgePath).filter(inRange);
  const cloud = loadRows(cloudPath).filter(inRange);
  const cloudKeys = new Set(cloud.map(identityKey));
  const missingOnCloud = edge
    .filter((row) => !cloudKeys.has(identityKey(row)))
    .map((row) => ({ deveui: row.deveui, recordedAt: row.recorded_at }));

  return { edgeCount: edge.length, cloudCount: cloud.length, missingOnCloud };
}

if (require.main === module) {
  const [, , edgePath, cloudPath, rangeStart, rangeEnd] = process.argv;
  if (!edgePath || !cloudPath || !rangeStart || !rangeEnd) {
    console.error('usage: diagnose-sensor-history-gap.js <edge.json> <cloud.json> <rangeStart> <rangeEnd>');
    process.exit(2);
  }

  const result = compareHistories({ edgePath, cloudPath, rangeStart, rangeEnd });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.missingOnCloud.length === 0 ? 0 : 1);
}

module.exports = { compareHistories, identityKey };
