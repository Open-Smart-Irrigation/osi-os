import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as ts from 'typescript';

const srcRoot = path.resolve(import.meta.dirname, '../src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Dark --primary is teal #2DD4BF, and white on it is 1.86:1. --on-primary is
// white in light and #04100E in dark, so it keeps light mode as it was. A wash
// such as bg-[var(--primary)]/10 is not a fill and may carry any text colour.
const PRIMARY_FILL = /(?:^|[\s:])bg-\[var\(--(?:primary|primary-hover|focus)\)\](?![/\w-])/;
// These fills are bright in both themes, so white fails on them in light as
// well: --warn-border is 2.15, --success-border and --toggle-on are 3.30 in
// light and 2.28 in dark, bg-yellow-600 is 2.93. --on-primary is white in
// light, so it fails here too. Text on them uses --on-warn or --on-success.
const BRIGHT_FILL =
  /(?:^|[\s:])bg-(?:\[var\(--(?:warn-border|success-border|toggle-on)\)\]|yellow-600)(?![/\w-])/;
const WHITE_TEXT = /(?:^|[\s:])text-white(?![\w-])/;
const ON_PRIMARY_TEXT = /(?:^|[\s:])text-\[var\(--on-primary\)\](?![\w-])/;

function pairsWhiteOnFill(classes: string): boolean {
  if (PRIMARY_FILL.test(classes) && WHITE_TEXT.test(classes)) return true;
  return BRIGHT_FILL.test(classes) && (WHITE_TEXT.test(classes) || ON_PRIMARY_TEXT.test(classes));
}

// Reads real string nodes rather than source lines, so a comment cannot trip
// this and two unrelated strings in one file are not treated as a pair.
function findOffendingLines(fileName: string, source: string): number[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const report = (node: ts.Node) => {
    lines.add(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
  };

  const nestedStrings = (node: ts.Node): ts.StringLiteralLike[] => {
    const out: ts.StringLiteralLike[] = [];
    const walk = (child: ts.Node) => {
      if (ts.isStringLiteralLike(child)) out.push(child);
      ts.forEachChild(child, walk);
    };
    walk(node);
    return out;
  };

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && pairsWhiteOnFill(node.text)) report(node);
    if (ts.isTemplateExpression(node)) {
      // `text-white ${active ? 'bg-[var(--primary)]' : 'bg-red-600'}` splits the
      // pair across the template and a branch, so check each branch with both.
      const fixed = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
      if (pairsWhiteOnFill(fixed)) report(node);
      for (const span of node.templateSpans) {
        for (const literal of nestedStrings(span.expression)) {
          if (pairsWhiteOnFill(`${fixed} ${literal.text}`)) report(literal);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...lines];
}

test('no class string puts white text on a fill it cannot be read on', () => {
  const offenders: string[] = [];
  for (const filePath of listSourceFiles(srcRoot)) {
    const lines = findOffendingLines(filePath, fs.readFileSync(filePath, 'utf8'));
    for (const line of lines) offenders.push(`${path.relative(srcRoot, filePath)}:${line}`);
  }
  assert.deepEqual(offenders, []);
});

test('the guard catches each way a class string can pair the two', () => {
  const flagged = (source: string) => findOffendingLines('fixture.tsx', source).length > 0;

  assert.ok(flagged(`<b className="bg-[var(--primary)] px-3 text-white" />;`));
  assert.ok(flagged(`<b className={open ? 'bg-[var(--primary)] text-white' : 'bg-[var(--card)]'} />;`));
  assert.ok(flagged('<b className={`px-3 ${open ? "bg-[var(--primary)] text-white" : ""}`} />;'));
  assert.ok(flagged('<b className={`text-white ${open ? "bg-[var(--primary)]" : "bg-red-600"}`} />;'));
  assert.ok(flagged('<b className={`bg-[var(--primary)] ${size} text-white`} />;'));
  assert.ok(flagged(`<b className="bg-red-600 hover:bg-[var(--primary-hover)] text-white" />;`));
  assert.ok(flagged(`const trigger = 'bg-[var(--focus)] text-white';`));
  assert.ok(flagged(`<b className="rounded-lg bg-[var(--warn-border)] px-4 text-white" />;`));
  assert.ok(flagged('<b className={`px-3 ${on ? "bg-[var(--toggle-on)] text-white" : ""}`} />;'));
  assert.ok(flagged(`<b className="bg-[var(--success-border)] hover:bg-green-700 text-white" />;`));
  assert.ok(flagged(`<b className="bg-yellow-600 hover:bg-yellow-700 text-white" />;`));
  assert.ok(flagged(`<b className="bg-[var(--warn-border)] text-[var(--on-primary)]" />;`));
});

test('the guard leaves other backgrounds and readable pairs alone', () => {
  const flagged = (source: string) => findOffendingLines('fixture.tsx', source).length > 0;

  assert.ok(!flagged(`<b className="bg-[var(--primary)] text-[var(--on-primary)]" />;`));
  assert.ok(!flagged(`<b className="bg-slate-900 text-white" />;`));
  assert.ok(!flagged(`<b className="bg-[var(--primary)]/10 text-white" />;`));
  assert.ok(!flagged(`const fill = 'bg-[var(--primary)]'; const label = 'text-white';`));
  assert.ok(!flagged('<b className={`px-3 ${open ? "bg-[var(--primary)] text-[var(--on-primary)]" : "bg-red-600 text-white"}`} />;'));
  assert.ok(!flagged(`// bg-[var(--primary)] text-white was the old pairing\nconst a = 1;`));
  assert.ok(!flagged(`<b className="bg-[var(--warn-border)] text-[var(--on-warn)]" />;`));
  assert.ok(!flagged(`<b className="bg-[var(--toggle-on)] text-[var(--on-success)]" />;`));
  assert.ok(!flagged(`<b className="border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn-text)]" />;`));
  // JournalMarkerLane pairs --on-primary with category fills such as sky-600.
  assert.ok(!flagged('<b className={`rounded-full ${"bg-sky-600"} text-[var(--on-primary)]`} />;'));
});
