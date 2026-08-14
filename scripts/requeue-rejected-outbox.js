#!/usr/bin/env node
'use strict';

// requeue-rejected-outbox.js — clears rejected_at/rejection_reason on matched
// sync_outbox rows so the push flow retries them (in occurred_at order).
//
// rejected_at is TERMINAL: nothing in this codebase clears it once set, and
// before this tool nothing requeued a rejected row either. 16k+ historical
// terminal rejections exist on live gateways.
//
// DO NOT run this against a live gateway database until ALL of the following
// hold:
//   1. The cloud-side keying/ownership causes of the rejections have been
//      fixed. Requeuing before that fix just reproduces the same rejections.
//   2. A fresh backup of the target farming.db has been taken.
//   3. The first live run uses --limit for a small probe batch — not an
//      unbounded run — so the outcome can be checked before requeuing the
//      rest.
//
// Default mode is DRY RUN: it prints what would be requeued (grouped by
// aggregate_type/op) and makes no changes. Pass --execute to actually clear
// rejected_at/rejection_reason on the matched rows.
//
// Usage:
//   node requeue-rejected-outbox.js <path-to-farming.db> \
//     [--aggregate-type TYPE] [--rejected-before ISO8601] \
//     [--rejected-after ISO8601] [--limit N] [--execute]

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const out = { execute: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--aggregate-type') out.aggregateType = requireValue(argv, i++, arg);
    else if (arg === '--rejected-before') out.rejectedBefore = requireValue(argv, i++, arg);
    else if (arg === '--rejected-after') out.rejectedAfter = requireValue(argv, i++, arg);
    else if (arg === '--limit') out.limit = Number(requireValue(argv, i++, arg));
    else if (arg === '--execute') out.execute = true;
    else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    else if (!out.dbPath) out.dbPath = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!out.dbPath) {
    throw new Error(
      'usage: requeue-rejected-outbox.js <path-to-farming.db> ' +
      '[--aggregate-type TYPE] [--rejected-before ISO8601] ' +
      '[--rejected-after ISO8601] [--limit N] [--execute]'
    );
  }
  if (out.rejectedBefore && Number.isNaN(Date.parse(out.rejectedBefore))) {
    throw new Error(`--rejected-before is not a valid ISO8601 timestamp: ${out.rejectedBefore}`);
  }
  if (out.rejectedAfter && Number.isNaN(Date.parse(out.rejectedAfter))) {
    throw new Error(`--rejected-after is not a valid ISO8601 timestamp: ${out.rejectedAfter}`);
  }
  if (out.limit !== undefined && (!Number.isInteger(out.limit) || out.limit <= 0)) {
    throw new Error(`--limit must be a positive integer: ${out.limit}`);
  }
  return out;
}

function buildWhere(opts) {
  const clauses = ['rejected_at IS NOT NULL'];
  const params = [];
  if (opts.aggregateType) {
    clauses.push('aggregate_type = ?');
    params.push(opts.aggregateType);
  }
  if (opts.rejectedBefore) {
    clauses.push('rejected_at < ?');
    params.push(opts.rejectedBefore);
  }
  if (opts.rejectedAfter) {
    clauses.push('rejected_at >= ?');
    params.push(opts.rejectedAfter);
  }
  return { where: clauses.join(' AND '), params };
}

// Matched rows, oldest occurred_at first — the order the push flow drains
// sync_outbox in. Both the dry-run summary and --execute operate on exactly
// this set, computed once per invocation so they never disagree.
function matchedIdsSql(where, hasLimit) {
  return `SELECT event_uuid FROM sync_outbox WHERE ${where} ORDER BY occurred_at ASC`
    + (hasLimit ? ' LIMIT ?' : '');
}

function summarize(db, opts) {
  const { where, params } = buildWhere(opts);
  const hasLimit = Number.isInteger(opts.limit);
  const subSql = matchedIdsSql(where, hasLimit);
  const subParams = hasLimit ? [...params, opts.limit] : params;

  const rows = db.prepare(
    `SELECT aggregate_type, op, COUNT(*) c
       FROM sync_outbox
      WHERE event_uuid IN (${subSql})
      GROUP BY aggregate_type, op
      ORDER BY aggregate_type, op`
  ).all(...subParams);

  const total = rows.reduce((sum, row) => sum + Number(row.c), 0);
  return { subSql, subParams, rows, total };
}

function printSummary(rows, total, label) {
  console.log(`[requeue] ${label} — ${total} row(s) match`);
  if (total === 0) return;
  console.log('  aggregate_type                op                             count');
  for (const row of rows) {
    console.log(`  ${String(row.aggregate_type).padEnd(31)}${String(row.op).padEnd(31)}${row.c}`);
  }
}

function run(opts) {
  if (!fs.existsSync(opts.dbPath)) {
    // DatabaseSync would otherwise CREATE an empty DB for a typoed path,
    // silently "succeeding" while the real target database is untouched.
    console.error(`[requeue] refusing: database file does not exist: ${opts.dbPath}`);
    process.exit(2);
  }

  const db = new DatabaseSync(opts.dbPath);
  try {
    const { subSql, subParams, rows, total } = summarize(db, opts);

    if (!opts.execute) {
      printSummary(rows, total, 'DRY RUN (default; pass --execute to apply)');
      return;
    }

    printSummary(rows, total, 'requeuing');
    const result = db.prepare(
      `UPDATE sync_outbox SET rejected_at = NULL, rejection_reason = NULL WHERE event_uuid IN (${subSql})`
    ).run(...subParams);
    console.log(`[requeue] cleared rejected_at/rejection_reason on ${result.changes} row(s)`);
  } finally {
    db.close();
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[requeue] usage error: ${err.message}`);
    process.exit(2);
    return;
  }
  run(opts);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, buildWhere, matchedIdsSql, summarize };
