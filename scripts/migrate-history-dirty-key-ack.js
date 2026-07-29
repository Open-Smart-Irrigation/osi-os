#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const canonicalPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const mirrorPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function loadWithRoundtripGuard(filePath) {
  const original = fs.readFileSync(filePath);
  const flows = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(flows)) !== 0) {
    throw new Error(`roundtrip guard failed for ${filePath}`);
  }
  return flows;
}

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected exactly one source anchor`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const flows = loadWithRoundtripGuard(canonicalPath);
loadWithRoundtripGuard(mirrorPath);

const build = flows.find((node) => node.id === 'sync-history-build');
const mark = flows.find((node) => node.id === 'sync-history-mark');
if (!build || !mark) throw new Error('history sync flow nodes not found');

build.func = replaceOnce(
  build.func,
  "  const prepared = rows.map((row) => helper.prepareRow(tableName, target.gatewayEui, row));\n  const segmentKeys = [];",
  "  const prepared = rows.map((row) => helper.prepareRow(tableName, target.gatewayEui, row));\n" +
    "  const dirtyRowKeysByHistoryKey = {};\n" +
    "  prepared.forEach((row, index) => {\n" +
    "    const dirtyRowKey = dirtyKeys && dirtyKeys[index];\n" +
    "    if (!dirtyRowKey) return;\n" +
    "    const submittedHistoryKey = String(row.historyKey || '');\n" +
    "    if (!dirtyRowKeysByHistoryKey[submittedHistoryKey]) {\n" +
    "      dirtyRowKeysByHistoryKey[submittedHistoryKey] = [];\n" +
    "    }\n" +
    "    dirtyRowKeysByHistoryKey[submittedHistoryKey].push(String(dirtyRowKey));\n" +
    "  });\n" +
    "  const segmentKeys = [];",
  'history build submitted-key mapping'
);
build.func = replaceOnce(
  build.func,
  "    dirtyKeys: dirtyKeys || [],\n    segmentKeys,",
  "    dirtyKeys: dirtyKeys || [],\n    dirtyRowKeysByHistoryKey,\n    segmentKeys,",
  'history build batch metadata'
);

mark.func = replaceOnce(
  mark.func,
  "  for (const dirtyKey of batch.dirtyKeys || []) {\n" +
    "    if (accepted.has(String(dirtyKey))) {\n" +
    "      await run(\n" +
    "        \"UPDATE sync_history_dirty_keys SET status='done', last_error=NULL, next_attempt_at=NULL WHERE peer_node='cloud' AND table_name=? AND row_key=?\",\n" +
    "        [tableName, dirtyKey]\n" +
    "      );\n" +
    "    }\n" +
    "  }",
  "  const completedDirtyRows = new Set();\n" +
    "  for (const [submittedHistoryKey, dirtyRowKeys] of Object.entries(batch.dirtyRowKeysByHistoryKey || {})) {\n" +
    "    if (!accepted.has(String(submittedHistoryKey))) continue;\n" +
    "    for (const dirtyRowKey of dirtyRowKeys || []) {\n" +
    "      completedDirtyRows.add(String(dirtyRowKey));\n" +
    "    }\n" +
    "  }\n" +
    "  for (const dirtyKey of batch.dirtyKeys || []) {\n" +
    "    if (accepted.has(String(dirtyKey))) completedDirtyRows.add(String(dirtyKey));\n" +
    "  }\n" +
    "  for (const dirtyRowKey of completedDirtyRows) {\n" +
    "    await run(\n" +
    "      \"UPDATE sync_history_dirty_keys SET status='done', last_error=NULL, next_attempt_at=NULL WHERE peer_node='cloud' AND table_name=? AND row_key=?\",\n" +
    "      [tableName, dirtyRowKey]\n" +
    "    );\n" +
    "  }",
  'history ACK durable-row completion'
);

const serialized = serialize(flows);
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
loadWithRoundtripGuard(canonicalPath);
loadWithRoundtripGuard(mirrorPath);

console.log('history dirty-key ACK migration: OK');
