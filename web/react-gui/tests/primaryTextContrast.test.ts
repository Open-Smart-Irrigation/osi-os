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
const WHITE_TEXT = /(?:^|[\s:])text-white(?![\w-])/;

function pairsWhiteOnPrimary(classes: string): boolean {
  return PRIMARY_FILL.test(classes) && WHITE_TEXT.test(classes);
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
    if (ts.isStringLiteralLike(node) && pairsWhiteOnPrimary(node.text)) report(node);
    if (ts.isTemplateExpression(node)) {
      // `text-white ${active ? 'bg-[var(--primary)]' : 'bg-red-600'}` splits the
      // pair across the template and a branch, so check each branch with both.
      const fixed = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
      if (pairsWhiteOnPrimary(fixed)) report(node);
      for (const span of node.templateSpans) {
        for (const literal of nestedStrings(span.expression)) {
          if (pairsWhiteOnPrimary(`${fixed} ${literal.text}`)) report(literal);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...lines];
}

test('no class string puts text-white on a --primary fill', () => {
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
});

test('the guard leaves other backgrounds and readable pairs alone', () => {
  const flagged = (source: string) => findOffendingLines('fixture.tsx', source).length > 0;

  assert.ok(!flagged(`<b className="bg-[var(--primary)] text-[var(--on-primary)]" />;`));
  assert.ok(!flagged(`<b className="bg-slate-900 text-white" />;`));
  assert.ok(!flagged(`<b className="bg-[var(--primary)]/10 text-white" />;`));
  assert.ok(!flagged(`const fill = 'bg-[var(--primary)]'; const label = 'text-white';`));
  assert.ok(!flagged('<b className={`px-3 ${open ? "bg-[var(--primary)] text-[var(--on-primary)]" : "bg-red-600 text-white"}`} />;'));
  assert.ok(!flagged(`// bg-[var(--primary)] text-white was the old pairing\nconst a = 1;`));
});
