'use strict';
// Evidence writer: one JSON file and one Markdown file per case, plus a run
// summary. The Markdown is what a human reads in a PR or an incident; the JSON
// is what a later run diffs against.

const fs = require('node:fs');
const path = require('node:path');

class CaseEvidence {
  constructor(runDir, caseId, title) {
    this.runDir = runDir;
    this.caseId = caseId;
    this.title = title;
    this.startedAt = new Date().toISOString();
    this.steps = [];
    this.checks = [];
    this.http = [];        // populated by the shared Rest transcript
    this.artifacts = [];
    this.notes = [];
    this.cleanup = [];
    this.status = 'RUNNING';
    this.error = null;
  }

  step(name, detail) {
    this.steps.push({ at: new Date().toISOString(), name, detail: detail === undefined ? null : detail });
  }

  note(text) { this.notes.push({ at: new Date().toISOString(), text }); }

  check(name, passed, detail) {
    this.checks.push({ at: new Date().toISOString(), name, passed: !!passed, detail: detail === undefined ? null : detail });
    return !!passed;
  }

  cleanupStep(name, ok, detail) {
    this.cleanup.push({ at: new Date().toISOString(), name, ok: !!ok, detail: detail === undefined ? null : detail });
  }

  artifact(name, relPath) { this.artifacts.push({ name, path: relPath }); }

  get failedChecks() { return this.checks.filter((c) => !c.passed); }

  finish(status, error) {
    this.status = status;
    this.error = error ? { message: String(error.message || error), stack: String(error.stack || '') } : null;
    this.finishedAt = new Date().toISOString();
  }

  write() {
    fs.mkdirSync(this.runDir, { recursive: true });
    const jsonPath = path.join(this.runDir, this.caseId + '.json');
    const mdPath = path.join(this.runDir, this.caseId + '.md');
    fs.writeFileSync(jsonPath, JSON.stringify({
      caseId: this.caseId,
      title: this.title,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this.error,
      checks: this.checks,
      steps: this.steps,
      notes: this.notes,
      cleanup: this.cleanup,
      http: this.http,
      artifacts: this.artifacts,
    }, null, 2) + '\n');
    fs.writeFileSync(mdPath, this._markdown());
    return { jsonPath, mdPath };
  }

  _markdown() {
    const L = [];
    L.push('# ' + this.caseId + ' — ' + this.title);
    L.push('');
    L.push('- Status: **' + this.status + '**');
    L.push('- Started: ' + this.startedAt);
    L.push('- Finished: ' + (this.finishedAt || '(unfinished)'));
    L.push('- Checks: ' + this.checks.filter((c) => c.passed).length + ' passed, ' + this.failedChecks.length + ' failed');
    L.push('');
    if (this.error) {
      L.push('## Error');
      L.push('');
      L.push('```');
      L.push(this.error.message);
      L.push('```');
      L.push('');
    }
    L.push('## Checks');
    L.push('');
    L.push('| # | Result | Assertion | Detail |');
    L.push('|---|---|---|---|');
    this.checks.forEach((c, i) => {
      L.push('| ' + (i + 1) + ' | ' + (c.passed ? 'PASS' : '**FAIL**') + ' | ' + mdCell(c.name) + ' | ' + mdCell(c.detail) + ' |');
    });
    L.push('');
    if (this.notes.length) {
      L.push('## Notes');
      L.push('');
      for (const n of this.notes) L.push('- ' + n.text);
      L.push('');
    }
    L.push('## Steps');
    L.push('');
    for (const s of this.steps) {
      L.push('- `' + s.at + '` ' + s.name + (s.detail == null ? '' : ' — ' + mdCell(s.detail)));
    }
    L.push('');
    if (this.http.length) {
      L.push('## HTTP transcript');
      L.push('');
      L.push('| Method | Path | Status | ms | Auth |');
      L.push('|---|---|---|---|---|');
      for (const r of this.http) {
        L.push('| ' + r.method + ' | `' + r.path + '` | ' + r.status + ' | ' + r.durationMs + ' | ' + (r.authenticated ? 'bearer' : '-') + ' |');
      }
      L.push('');
    }
    L.push('## Cleanup');
    L.push('');
    if (!this.cleanup.length) L.push('_(nothing to clean up)_');
    for (const c of this.cleanup) L.push('- ' + (c.ok ? 'OK' : '**FAILED**') + ' — ' + c.name + (c.detail == null ? '' : ' (' + mdCell(c.detail) + ')'));
    L.push('');
    if (this.artifacts.length) {
      L.push('## Artifacts');
      L.push('');
      for (const a of this.artifacts) L.push('- ' + a.name + ': `' + a.path + '`');
      L.push('');
    }
    return L.join('\n');
  }
}

function mdCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300);
}

function writeRunSummary(runDir, meta, results) {
  fs.mkdirSync(runDir, { recursive: true });
  const jsonPath = path.join(runDir, 'summary.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ meta, results }, null, 2) + '\n');

  const L = [];
  L.push('# Silvan E2E harness run');
  L.push('');
  L.push('- Gateway: `' + meta.gatewayEui + '` (' + meta.sshHost + ')');
  L.push('- API: `' + meta.apiBase + '`  MQTT: `' + meta.mqttHost + ':' + meta.mqttPort + '`');
  L.push('- Started: ' + meta.startedAt);
  L.push('- Finished: ' + meta.finishedAt);
  L.push('- Harness commit: `' + (meta.commit || 'unknown') + '`');
  L.push('');
  L.push('## Matrix');
  L.push('');
  L.push('| Case | Title | Result | Checks | Duration |');
  L.push('|---|---|---|---|---|');
  for (const r of results) {
    L.push('| ' + r.caseId + ' | ' + mdCell(r.title) + ' | ' + (r.status === 'PASS' ? 'PASS' : '**' + r.status + '**') +
      ' | ' + r.passedChecks + '/' + r.totalChecks + ' | ' + r.durationMs + ' ms |');
  }
  L.push('');
  const failed = results.filter((r) => r.status !== 'PASS');
  if (failed.length) {
    L.push('## Failures');
    L.push('');
    for (const r of failed) {
      L.push('### ' + r.caseId);
      L.push('');
      for (const c of r.failures) L.push('- ' + c.name + (c.detail == null ? '' : ' — ' + mdCell(c.detail)));
      if (r.error) L.push('- ERROR: ' + mdCell(r.error.message));
      L.push('');
    }
  }
  const mdPath = path.join(runDir, 'summary.md');
  fs.writeFileSync(mdPath, L.join('\n'));
  return { jsonPath, mdPath };
}

module.exports = { CaseEvidence, writeRunSummary };
