import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The four files that define the history state-colour vocabulary. Their cloud
// twins port these exact class strings (S4 T3/T4/T5), so a hardcoded palette
// utility here is not a local defect — it is a defect the cloud inherits.
//
// This guard is NOT edge-wide. Reading 3 found palette hits in seven edge
// history/analysis files; the other three are deliberately out of scope for
// this task and this guard, so 11 offenders survive by design:
// visualizations/DendroStressEventsView.tsx (9 hits), mobile/HistoryExportSheet.tsx
// (1), mobile/HistoryInspectorSheet.tsx (1). T11 ledger item 3 carries these
// same three files.
const DEFINITION_FILES = [
  'components/history/visualizations/HistoryMonthCalendarView.tsx',
  'components/history/visualizations/IrrigationEventTimelineView.tsx',
  'components/history/visualizations/GatewayStatusOverviewView.tsx',
  'components/history/InterpretationList.tsx',
];

const PALETTE =
  'slate|gray|grey|zinc|neutral|stone|amber|emerald|red|blue|orange|yellow|lime|green|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose';
const HARDCODED = new RegExp(
  `\\b(?:bg|text|border|ring|divide|from|to)-(?:\\[#[0-9a-fA-F]{3,8}\\]|(?:${PALETTE})-\\d{2,3}|white|black)\\b`,
  'g',
);

test('the history state-colour definitions use tokens, not palette literals', () => {
  const srcRoot = path.resolve(import.meta.dirname, '../src');
  const offenders: string[] = [];
  for (const rel of DEFINITION_FILES) {
    const source = fs.readFileSync(path.join(srcRoot, rel), 'utf8');
    for (const hit of source.match(HARDCODED) ?? []) offenders.push(`${rel}: ${hit}`);
  }
  assert.deepEqual(offenders, []);
});

// A *-border token is a border. Measured against its own wash it is 1.39–1.74
// in light theme, so it can never carry text or an icon glyph.
test('no --cal-*-border/-solid token appears in a foreground utility', () => {
  const srcRoot = path.resolve(import.meta.dirname, '../src');
  const offenders: string[] = [];
  const misuse = /(?:text|placeholder|caret|decoration|fill|stroke)-\[var\(--cal-[a-z]+-(?:border|solid)\)\]/;
  for (const rel of DEFINITION_FILES) {
    const source = fs.readFileSync(path.join(srcRoot, rel), 'utf8');
    if (misuse.test(source)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});
