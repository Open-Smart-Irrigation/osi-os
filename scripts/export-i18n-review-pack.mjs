#!/usr/bin/env node
// Regenerates docs/i18n-review/terms-<locale>.csv from web/react-gui/public/locales.
// shared_with_english=yes marks rows whose translation is byte-identical to English.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = path.join(root, 'web/react-gui/public/locales');
const outDir = path.join(root, 'docs/i18n-review');
const locales = readdirSync(localesDir).filter((l) => l !== 'en').sort();
const namespaces = readdirSync(path.join(localesDir, 'en')).map((f) => f.replace(/\.json$/, '')).sort();

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'string' ? [[key, v]] : flatten(v, key);
  });

const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

for (const locale of locales) {
  const rows = [`namespace,key,english,${locale},shared_with_english`];
  for (const ns of namespaces) {
    const en = new Map(flatten(JSON.parse(readFileSync(path.join(localesDir, 'en', `${ns}.json`), 'utf8'))));
    const tr = new Map(flatten(JSON.parse(readFileSync(path.join(localesDir, locale, `${ns}.json`), 'utf8'))));
    for (const [key, enValue] of en) {
      const trValue = tr.get(key) ?? '';
      rows.push([ns, key, esc(enValue), esc(trValue), trValue === enValue ? 'yes' : ''].join(','));
    }
  }
  writeFileSync(path.join(outDir, `terms-${locale}.csv`), rows.join('\n') + '\n');
  console.log(`terms-${locale}.csv: ${rows.length - 1} rows`);
}
