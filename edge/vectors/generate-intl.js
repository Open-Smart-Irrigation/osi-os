#!/usr/bin/env node
'use strict';
// Locale and Intl facts of the Node that runs it, as JSON on stdout.
//
//   node edge/vectors/generate-intl.js [--etc-tz] [--full-dir DIR] > OUT.json
//
// Run it with the x86 oracle (Node 20.18.3) and, under a service-like
// environment (env -i PATH=...), with the gateway image's own node in the arm64
// emulator guest. edge/vectors/intl-gateway.vectors.json is the guest's output,
// intl-x86.vectors.json the oracle's. Go tests load the gateway file.
//
// --etc-tz (guest only, needs root on OpenWrt): also rewrite the file behind
// /etc/TZ with each rule in ETC_TZ_RULES, run a child node with TZ unset and
// restore the original content. --full-dir writes the full code-point sweeps
// next to the hashes (development only; not committed).
//
// Every section runs in its own try/catch and records an error as data.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
const ETC_TZ = args.includes('--etc-tz');
const fullAt = args.indexOf('--full-dir');
const FULL_DIR = fullAt >= 0 ? args[fullAt + 1] : null;
const ZONES_FILE = path.join(__dirname, '../go/internal/jstimezone/zones_iana.vectors.json');

const out = { about: 'Locale/Intl behaviour of this Node; see edge/vectors/generate-intl.js', sections: {} };
function section(name, fn) {
  try { out.sections[name] = fn(); } catch (error) { out.sections[name] = { error: String(error && error.stack || error) }; }
}
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sign = (n) => (n < 0 ? '-' : n > 0 ? '+' : '0');
function full(name, text) { if (FULL_DIR) fs.writeFileSync(path.join(FULL_DIR, name), text); }
// Code points of the sweeps: planes 0-3 and the tag/variation block of plane
// 14, surrogates excluded (Go strings cannot hold them).
function* sweep() {
  for (let c = 0; c <= 0x323ff; c++) if (c < 0xd800 || c > 0xdfff) yield c;
  for (let c = 0xe0000; c <= 0xe01ef; c++) yield c;
}
const hex = (s) => Array.from(s, (ch) => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');

// ---- facts -----------------------------------------------------------------
section('facts', () => {
  const vars = process.config && process.config.variables || {};
  const config = {};
  for (const key of Object.keys(vars).sort()) if (/icu|intl|i18n/.test(key)) config[key] = vars[key];
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return { error: e.code || String(e) }; } };
  const link = (p) => { try { return fs.readlinkSync(p); } catch (e) { return { error: e.code || String(e) }; } };
  const env = {};
  for (const key of ['TZ', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_COLLATE', 'LC_CTYPE', 'LC_TIME', 'NODE_ICU_DATA', 'NODE_OPTIONS']) {
    env[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
  }
  return {
    platform: process.platform, arch: process.arch, versions: process.versions, config_variables: config,
    env, etc_TZ: read('/etc/TZ'), etc_localtime_link: link('/etc/localtime'), etc_TZ_link: link('/etc/TZ'),
    default_locale: {
      collator: new Intl.Collator().resolvedOptions(),
      date_time_format: new Intl.DateTimeFormat().resolvedOptions(),
      number_format: new Intl.NumberFormat().resolvedOptions(),
      supported_locales_of: Intl.Collator.supportedLocalesOf(['en', 'en-US', 'en-CA', 'en-GB', 'de', 'de-CH', 'fr', 'sw', 'lg', 'ja']),
      dtf_supported_locales_of: Intl.DateTimeFormat.supportedLocalesOf(['en', 'en-US', 'en-CA', 'en-GB', 'de', 'de-CH', 'fr', 'sw', 'lg', 'ja']),
      resolved: Object.fromEntries(['en', 'en-US', 'en-CA', 'en-GB', 'de-CH', 'fr', 'und'].map((tag) => [tag, {
        collator: new Intl.Collator(tag).resolvedOptions().locale,
        date_time_format: new Intl.DateTimeFormat(tag).resolvedOptions().locale,
      }])),
    },
  };
});

// ---- collation ---------------------------------------------------------------
const PROBES = [
  // r6-mut-lifecycle-collation (class C) and r6-mut-fixed-snapshot-collation (class C2)
  'abcdef00-0000-4000-8000-0000000000c1', 'ABCDEF00-0000-4000-8000-0000000000C2', '\u0000synthetic-review-weekly',
  'abcdef00_0000', '10-review', '9-review', '[review]',
  'A1100000-0000-4000-8000-000000000006', 'a1100000-0000-4000-8000-000000000006',
  'b1100000-0000-4000-8000-00000000000-', 'b1100000-0000-4000-8000-00000000000_',
  // valve_lifecycle_order_test.go
  '0B8F6A3E-6C1A-4F61-9A43-2F1D8B3E9C21', '1a000000-0000-4000-8000-000000000000', '0b8F6a3e-6c1a-4f61-9a43-2f1d8b3e9c21',
  '0b8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c21', '0B8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c21',
  '\u0009ceaa2200-0000-4000-8000-000000000002', ' lead', '[bracket', '~tilde', '10', '9', 'a_b', 'a-b', 'ab',
  'ceaa2200 0000', 'ceaa2200_0000', 'ceaa2200-0000-4000-8000-000000000001', 'Ceaa2200-0000-4000-8000-000000000001',
  'CEAA2200-0000-4000-8000-000000000001', 'ceaa2200.0000', '﻿feff',
];
const MORE = [
  // empty, NUL, BOM, controls, whitespace
  '', '\u0000', '\u0000\u0000', 'a\u0000', '\u0000a', 'a\u0000b', '﻿', 'a﻿b', '\u0001', '\u001f', '\u007f',
  '\t', '\n', '\r', ' ', '  ', ' ', ' ', '​', '‌', '‍', ' ', '　', '\u0085', '᠎',
  // ASCII punctuation and symbols
  ...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''),
  // case, accents, ligatures, expansions
  'a', 'A', 'b', 'B', 'z', 'Z', 'e', 'E', 'é', 'É', 'é', 'ë', 'ê', 'è', 'ete', 'Ete', 'été', 'Été', 'zürich', 'Zurich', 'zurich',
  'ss', 'ß', 'SS', 'ẞ', 'ae', 'æ', 'Æ', 'AE', 'oe', 'œ', 'ø', 'o', 'ö', 'å', 'Å', 'Å', 'Å', 'ı', 'i', 'İ', 'I',
  'ǅ', 'ǆ', 'Ǆ', 'dž', 'ﬁ', 'fi', 'ﬀ', 'ff', 'l·l', 'ŀl', 'ŀ', 'ĳ', 'ij', 'ð', 'þ', 'th', 'đ', 'ł',
  // combining-mark order (canonical equivalence, non-FCD)
  'ạ́', 'ạ́', 'ạ́', 'ạ́', 'á', 'á', 'ấ', 'ấ',
  'á̂', 'à́', 'á̀', 'q̣̇', 'q̣̇', 'x̀̕', 'x̀̕',
  'ǟ', 'ǟ', 'ā̈', 'ợ', 'ợ', 'ợ', 'ở', '́', '́a', '̣́',
  'e͏́', 'é͏',
  // digits and numbers
  '0', '1', '2', '9', '10', '01', '1.5', '1,5', '-1', '+1', '1e3', '½', '²', '¹', '①', 'Ⅳ', 'iv', '٣', '۳', '३', '๓', '༣', '፫',
  '１', '𝟘', '𝟙', '0x10', '00', '000', '1_000', '1-000', '1 000',
  // scripts
  'α', 'Α', 'β', 'ά', 'ς', 'σ', 'Σ', 'ж', 'Ж', 'ё', 'е', 'й', 'й', 'ا', 'ب', 'أ', 'أ', 'א', 'ב', 'अ', 'क', 'क्ष', 'कि',
  'ก', 'เก', 'แก', 'กเ', 'ข', 'ກ', 'ເກ', 'ཀ', 'ཀྵ', 'ཱི', 'ཱི', 'ཱྀ', 'ཱྀ', 'ა', 'ア', 'あ', 'ｱ', 'ﾊﾟ', 'パ', 'ハ', 'ば', 'は', 'ー', 'ゝ',
  '一', '丁', '日本', '中文', '一一', '鿿', '﨎', '豈', '\u{20000}', '\u{2a6df}', '\u{30000}', '\u{31350}', '\u{2ebf0}',
  '\u{17000}', '\u{18b00}', '\u{1b170}', '\u{18d00}', '가', '각', '각', '가', '힣', 'ㄱ', 'ㄱㅏ',
  'ꙮ', 'ᏸ', 'Ᏸ', '\u{1d2c0}', '\u{1e4d0}', '\u{11f00}', '\u{10d40}',
  // symbols, emoji, special code points
  '€', '$', '£', '¥', '₿', '₹', '©', '®', '™', '°', '%', '‰', '§', '¶', '†', '•', '…', '–', '—', '−', '‐', '‑', '«', '»', '“', '”', '‘', '’', '„',
  '😀', '😁', '🌍', '👍', '👍🏽', '👨‍👩‍👧', '🇨🇭', '🇺🇬', '🏳️‍🌈', '\u{1f9cc}', '\u{1fae8}', '\u{1faf8}',
  '�', '￾', '￿', '﷐', '', '\u{f0000}', '͸', '\u{e0001}', '\u{e0100}', '\u{10ffff}', '\u{e007f}',
  // mixed
  'zone 10', 'Zone 2', 'zone 2', '_x', 'x_', 'a b', 'a  b', 'a-b-c', 'a.b', 'a/b', 'a\\b', 'A840410000000001', 'a840410000000001',
  '2026-03-29T02:30:00Z', '2026-03-29 02:30', '2026-03-29T01:30:00.000Z', '2026-10-25T00:59:59.999Z',
];
const LONE = ['\ud800', '\udc00', 'a\ud800b', '􏿿'];
const LONE_PAIRS = [
  '\ud800', '\ud801', '\udbfe', '\udbff', '\udc00', '\udc01', '\udffe', '\udfff',
  '\ud7fb', '\ud7fc', '\ud7ff', '\ue000', '\uf8ff', '\ufdd0', '\ufffd', '\ufffe', '\uffff', '\u0378',
  '\ud800\udc00', '\udbff\udfff', '\ud83d\ude00', '\ud840\udc00',
  '', '\u0000', ' ', '0', '9', 'A', 'a', 'z', '~', '\u4e00',
  'a\ud800', '\ud800a', 'a\udc00b', '\udc00\ud800', '\ud800\ud800', '\udfff\udfff', '\ud800\u0301', '\u0301\ud800',
  'x\ud800', 'x\ufffd', 'x\ud800y', 'x\ufffdy',
];
function collationStrings() { return Array.from(new Set([...PROBES, ...MORE])); }

section('collation', () => {
  const strings = collationStrings();
  const collator = new Intl.Collator();
  // signs[i][j] = sign(strings[i].localeCompare(strings[j])), one row per string
  const signs = strings.map((a) => strings.map((b) => sign(a.localeCompare(b))).join(''));
  const viaCollator = strings.every((a, i) => strings.every((b, j) => sign(collator.compare(a, b)) === signs[i][j]));
  const viaEn = strings.every((a, i) => strings.every((b, j) => sign(a.localeCompare(b, 'en')) === signs[i][j]));
  const sorted = [...strings].sort((a, b) => a.localeCompare(b));
  const probesSorted = [...PROBES].sort((a, b) => a.localeCompare(b));
  const lone = LONE.map((a) => ({ input: a.split('').map((u) => u.charCodeAt(0).toString(16)), vs: strings.slice(0, 40).map((b) => sign(a.localeCompare(b))).join('') }));
  // Lone surrogates against their neighbours, U+FFFD, paired surrogates and
  // ASCII. JSON cannot carry a lone surrogate to Go, so each string is its
  // UTF-16 code units in hex; signs[i][j] = sign(units_i.localeCompare(units_j)).
  const pairs = LONE_PAIRS.map((s) => s.split('').map((u) => u.charCodeAt(0).toString(16)));
  const pairSigns = LONE_PAIRS.map((a) => LONE_PAIRS.map((b) => sign(a.localeCompare(b))).join(''));
  return { strings, signs, sorted, probes_sorted: probesSorted, collator_compare_agrees: viaCollator, locale_en_agrees: viaEn, lone_surrogates: lone,
    lone_surrogate_pairs: { units: pairs, signs: pairSigns } };
});

section('collation_sweep', () => {
  // Single code points sorted by Intl.Collator().compare (what localeCompare
  // uses); '=' joins a tie class, '<' separates classes, input order is code
  // point order so ties keep it.
  const cps = Array.from(sweep());
  const collator = new Intl.Collator();
  const strs = cps.map((c) => String.fromCodePoint(c));
  const idx = cps.map((_, i) => i).sort((a, b) => collator.compare(strs[a], strs[b]) || a - b);
  let text = '';
  for (let k = 0; k < idx.length; k++) {
    if (k) text += collator.compare(strs[idx[k - 1]], strs[idx[k]]) === 0 ? '=' : '<';
    text += cps[idx[k]].toString(16);
  }
  full('collation-sweep.txt', text);
  return { count: cps.length, sha256: sha(text) };
});

// Deterministic fuzz: mulberry32 picks code points from weighted pools; the
// result is the comparison sign of each consecutive pair. Go regenerates the
// same strings (intl_vectors_test.go).
const FUZZ_POOLS = [
  [0x20, 0x7e], [0x41, 0x5a], [0x61, 0x7a], [0x30, 0x39], [0x00, 0x1f], [0xc0, 0x24f], [0x300, 0x36f], [0x370, 0x3ff],
  [0x400, 0x4ff], [0x591, 0x5f4], [0x600, 0x6ff], [0x900, 0x97f], [0xe01, 0xe5b], [0xe81, 0xedf], [0xf00, 0xfda],
  [0x1100, 0x11ff], [0x1e00, 0x1eff], [0x2000, 0x206f], [0x20a0, 0x20c0], [0x2150, 0x218b], [0x2460, 0x24ff],
  [0x3040, 0x30ff], [0x3131, 0x318e], [0x4e00, 0x4e40], [0xac00, 0xac40], [0xfb00, 0xfb4f], [0xfe00, 0xfe0f],
  [0xff00, 0xffef], [0xfff0, 0xffff], [0x1f300, 0x1f64f], [0x1f900, 0x1faff], [0x20000, 0x20010], [0x2ebf0, 0x2ec00],
  [0x31350, 0x31360], [0x17000, 0x17010], [0xe0000, 0xe007f], [0x0378, 0x0379], [0xd7b0, 0xd7fb],
];
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fuzzStrings(seed, count) {
  const rnd = mulberry32(seed);
  const result = [];
  for (let i = 0; i < count; i++) {
    const len = Math.floor(rnd() * 6);
    let s = '';
    for (let k = 0; k < len; k++) {
      const [lo, hi] = FUZZ_POOLS[Math.floor(rnd() * FUZZ_POOLS.length)];
      let c = lo + Math.floor(rnd() * (hi - lo + 1));
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      s += String.fromCodePoint(c);
    }
    // Every fourth string extends the previous one, so prefixes and near ties occur.
    if (i % 4 === 3 && result.length) s = result[result.length - 1] + s;
    result.push(s);
  }
  return result;
}
section('collation_fuzz', () => {
  const seed = 20261125, count = 20000;
  const strs = fuzzStrings(seed, count);
  let signs = '';
  for (let i = 1; i < strs.length; i++) signs += sign(strs[i - 1].localeCompare(strs[i]));
  const sample = strs.slice(0, 5).map(hex);
  return { seed, count, signs, first_strings_hex: sample };
});

// ---- case mapping and normalization -----------------------------------------
const CASE_INPUTS = [
  '', 'abc', 'ABC', 'ß', 'ẞ', 'straße', 'ǅ', 'ǆ', 'Ǆ', 'ﬁ', 'ﬀ', 'ŉ', 'ΐ', 'ΰ', 'և', 'ᾳ', 'ᾼ', 'ΑΣ', 'ΑΣΑ', 'Σ', 'ΑΣ.', 'ΑΣ́',
  'İ', 'I', 'ı', 'i', 'Ä', 'ä', 'Ω', 'Ω', 'K', 'Å', 'ꞵ', 'Ꞵ', 'ᲀ', 'ᏸ', 'Ᏸ', '\u{10400}', '\u{10428}', '\u{1e900}', '\u{1e922}',
  'ⓐ', 'Ⓐ', 'ǰ', 'ͅ', 'ῲ', 'a\u0000b', '﻿x', 'a840410000000001', ' a840410000000001 ', 'ünknown', 'UNKNOWN',
  '\u{10d50}', '\u{10d70}', '\u{16e40}', '\u{16e60}', '\u{1e030}',
];
section('case', () => ({
  vectors: CASE_INPUTS.map((s) => ({
    input: s, upper: s.toUpperCase(), lower: s.toLowerCase(),
    locale_upper: s.toLocaleUpperCase(), locale_lower: s.toLocaleLowerCase(),
    tr_upper: s.toLocaleUpperCase('tr'), tr_lower: s.toLocaleLowerCase('tr'),
  })),
}));
section('case_sweep', () => {
  let upper = '', lower = '', localeUpper = '', localeLower = '';
  for (const c of sweep()) {
    const s = String.fromCodePoint(c);
    const u = s.toUpperCase(), l = s.toLowerCase();
    if (u !== s) upper += c.toString(16) + ':' + hex(u) + '\n';
    if (l !== s) lower += c.toString(16) + ':' + hex(l) + '\n';
    if (s.toLocaleUpperCase() !== u) localeUpper += c.toString(16) + '\n';
    if (s.toLocaleLowerCase() !== l) localeLower += c.toString(16) + '\n';
  }
  full('case-upper.txt', upper); full('case-lower.txt', lower);
  return { upper_sha256: sha(upper), lower_sha256: sha(lower), upper_changes: upper.split('\n').length - 1,
    lower_changes: lower.split('\n').length - 1, locale_upper_differs: localeUpper, locale_lower_differs: localeLower };
});
section('normalize', () => {
  const forms = ['NFC', 'NFD', 'NFKC', 'NFKD'];
  const inputs = ['', 'é', 'é', 'ạ́', 'ạ́', 'Å', 'Å', 'ﬁ', '①', 'ｱ', 'ﾊﾟ', '각', '각',
    '̈́', 'ǅ', '\u{1d15e}', '\u{2f800}', 'a\u0000b', '﻿', 'ཱི', 'ཱུ', 'ཱྀ'];
  const vectors = inputs.map((s) => Object.fromEntries([['input', s], ...forms.map((f) => [f, s.normalize(f)])]));
  const digests = {};
  for (const f of forms) {
    let text = '';
    for (const c of sweep()) { const s = String.fromCodePoint(c), n = s.normalize(f); if (n !== s) text += c.toString(16) + ':' + hex(n) + '\n'; }
    digests[f] = sha(text);
    full(`normalize-${f}.txt`, text);
  }
  return { vectors, sweep_sha256: digests };
});

// ---- time zones and date formatting ------------------------------------------
section('zone_names', () => {
  const corpus = JSON.parse(fs.readFileSync(ZONES_FILE, 'utf8'));
  const canonical = (name) => {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone; }
    catch (error) { if (error instanceof RangeError) return null; throw error; }
  };
  const undefinedLocale = (name) => { try { Intl.DateTimeFormat(undefined, { timeZone: name }); return true; } catch (_) { return false; } };
  const differences = [];
  let text = '';
  for (const [name, want, wantTrim] of corpus.cases) {
    const got = canonical(name), gotTrim = canonical(name.trim());
    text += JSON.stringify([name, got, gotTrim]) + '\n';
    if (got !== want || gotTrim !== wantTrim || undefinedLocale(name) !== (want !== null)) {
      differences.push({ name, oracle_file: [want, wantTrim], here: [got, gotTrim], undefined_locale_accepts: undefinedLocale(name) });
    }
  }
  const supported = Intl.supportedValuesOf('timeZone');
  return { corpus_source: corpus.source, count: corpus.cases.length, sha256: sha(text), differences,
    supported_count: supported.length, supported_sha256: sha(supported.join('\n')) };
});

const ZONES = ['UTC', 'Etc/UTC', 'Europe/Zurich', 'Africa/Kampala', 'Africa/Nairobi', 'America/Los_Angeles', 'Pacific/Kiritimati',
  'Etc/GMT-14', 'Etc/GMT+12', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'America/Argentina/Buenos_Aires', 'Europe/Kyiv', 'Europe/Kiev',
  'Antarctica/Troll', 'America/Sao_Paulo', 'Asia/Tehran', 'America/St_Johns'];
const INSTANTS = [
  // Europe/Zurich DST 2026: 29 March 01:00Z, 25 October 01:00Z (and 1 ms either side)
  Date.UTC(2026, 2, 29, 0, 59, 59, 999), Date.UTC(2026, 2, 29, 1), Date.UTC(2026, 9, 25, 0, 59, 59, 999), Date.UTC(2026, 9, 25, 1),
  // America/Los_Angeles DST 2026: 8 March 10:00Z, 1 November 09:00Z
  Date.UTC(2026, 2, 8, 9, 59, 59), Date.UTC(2026, 2, 8, 10), Date.UTC(2026, 10, 1, 8, 59, 59), Date.UTC(2026, 10, 1, 9),
  // Lord Howe half-hour DST: 5 April 2026 15:00Z, 4 October 2026 15:30Z
  Date.UTC(2026, 3, 4, 14, 59), Date.UTC(2026, 3, 4, 15, 1), Date.UTC(2026, 9, 3, 15, 29), Date.UTC(2026, 9, 3, 15, 31),
  // day and year edges, leap day, far past and future, era boundary
  Date.UTC(2026, 11, 31, 23, 59, 59), Date.UTC(2027, 0, 1, 0, 0, 0), Date.UTC(2028, 1, 29, 12), Date.UTC(2026, 6, 1, 12),
  0, -1, Date.UTC(1900, 0, 1), Date.UTC(1969, 11, 31, 23, 30), Date.UTC(1991, 5, 1, 12), Date.UTC(2038, 0, 19, 3, 14, 8),
  Date.UTC(2100, 2, 28, 12), Date.UTC(9999, 11, 31, 23, 59, 59), 8.64e15, -8.64e15, -62135596800000, -62135596800001,
  -62198755200000, Date.UTC(-1, 5, 15), Date.now() - (Date.now() % 86400000),
];
const FORMATS = {
  'plan.js buildFormatter': ['en-US', { hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }],
  'zone-config-fn zoneLocalToday': ['en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }],
  'merge-device-data rain_day': ['en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }],
  'osi-rain date': ['en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }],
  'osi-rain dateTime': ['en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }],
  'default': [undefined, {}],
};
section('date_time_format', () => {
  const formats = {};
  for (const [label, [locale, options]] of Object.entries(FORMATS)) {
    const rows = [];
    for (const zone of ZONES) {
      let fmt;
      try { fmt = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }); } catch (e) { rows.push({ zone, error: String(e) }); continue; }
      const resolved = fmt.resolvedOptions();
      const values = INSTANTS.map((ms) => {
        try { return fmt.formatToParts(new Date(ms)).map((p) => p.type + '=' + p.value).join('|'); } catch (e) { return 'error=' + e.message; }
      });
      rows.push({ zone, resolved_locale: resolved.locale, resolved_zone: resolved.timeZone, calendar: resolved.calendar, numbering: resolved.numberingSystem, values });
    }
    formats[label] = { locale: locale === undefined ? null : locale, options, rows };
  }
  return { instants: INSTANTS, formats };
});
section('locale_strings', () => {
  const ms = Date.UTC(2026, 6, 1, 12, 34, 56, 789);
  const d = new Date(ms);
  const z = { timeZone: 'Europe/Zurich' };
  return {
    instant: ms,
    toLocaleString: d.toLocaleString(), toLocaleDateString: d.toLocaleDateString(), toLocaleTimeString: d.toLocaleTimeString(),
    toLocaleString_en_US_zurich: d.toLocaleString('en-US', z), toLocaleString_de_CH_zurich: d.toLocaleString('de-CH', z),
    toLocaleString_en_CA_zurich: d.toLocaleString('en-CA', z), toLocaleDateString_en_CA: d.toLocaleDateString('en-CA', { timeZone: 'UTC' }),
    toLocaleDateString_en_GB: d.toLocaleDateString('en-GB', { timeZone: 'UTC' }),
    number: [0, -0, 1234.5, 1234567.891, -1e21, 1e-7, NaN, Infinity, 0.1 + 0.2].map((n) => ({
      n: String(n), toLocaleString: n.toLocaleString(), en_US: n.toLocaleString('en-US'), de_CH: n.toLocaleString('de-CH'),
      fr: n.toLocaleString('fr'), number_format: new Intl.NumberFormat().format(n),
      percent: new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(n),
    })),
  };
});

// ---- process zone (V8 asks ICU, which reads TZ and then the system files) ---
const PROCESS_PROBE = `
const out = { resolved: String(Intl.DateTimeFormat().resolvedOptions().timeZone), rows: [], parse: {} };
for (const ms of ${JSON.stringify(INSTANTS.slice(0, 26))}) {
  const d = new Date(ms);
  out.rows.push([ms, d.getTimezoneOffset(), d.toString(), d.toTimeString(), d.toLocaleString(), d.getHours(), d.getDate()]);
}
for (const s of ['2026-03-29T02:30:00', '2026-03-29 02:30', '2026-10-25T02:30:00', '2026-07-01T12:00:00', 'Jul 1 2026 12:00',
  '1980-07-01T12:00', '1970-01-01T00:00:00', '2026-07-01', 'Wed Jul 01 2026 12:00:00', '2026/07/01 12:00']) out.parse[s] = Date.parse(s);
out.local_ctor = [new Date(2026, 2, 29, 2, 30).getTime(), new Date(2026, 9, 25, 2, 30).getTime(), new Date(2026, 6, 1, 6, 0).getTime()];
process.stdout.write(JSON.stringify(out));`;
const TZ_ENV = [null, '', 'UTC', 'UTC0', 'GMT0', 'Europe/Zurich', ':Europe/Zurich', 'CET-1CEST,M3.5.0,M10.5.0/3', 'EAT-3',
  'Africa/Kampala', '<+0545>-5:45', 'PST8PDT,M3.2.0,M11.1.0', 'Not/AZone', 'XYZ-3'];
const ETC_TZ_RULES = ['UTC', 'UTC0', 'GMT0', 'CET-1CEST,M3.5.0,M10.5.0/3', 'EAT-3', '<+0545>-5:45', 'PST8PDT,M3.2.0,M11.1.0',
  'Europe/Zurich', '', 'XYZ-3'];
function probe(env) {
  try { return JSON.parse(execFileSync(process.execPath, ['-e', PROCESS_PROBE], { env, encoding: 'utf8', timeout: 120000 })); }
  catch (e) { return { error: String(e && e.message || e) }; }
}
function baseEnv() {
  const env = { ...process.env };
  delete env.TZ;
  return env;
}
section('process_zone_env', () => TZ_ENV.map((tz) => {
  const env = baseEnv();
  if (tz !== null) env.TZ = tz;
  return { TZ: tz, result: probe(env) };
}));
section('process_zone_etc_tz', () => {
  if (!ETC_TZ) return { skipped: 'pass --etc-tz in the disposable guest' };
  let target;
  try { target = fs.realpathSync('/etc/TZ'); } catch (_) { target = fs.existsSync('/etc/TZ') ? '/etc/TZ' : '/tmp/TZ'; }
  const original = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const rows = [{ rule: 'factory', content: original === null ? null : original.toString('utf8'), result: probe(baseEnv()) }];
  try {
    for (const rule of ETC_TZ_RULES) {
      fs.writeFileSync(target, rule + '\n');
      rows.push({ rule, target, result: probe(baseEnv()) });
    }
    fs.rmSync(target, { force: true });
    rows.push({ rule: null, target, absent: true, result: probe(baseEnv()) });
  } finally {
    if (original === null) fs.rmSync(target, { force: true }); else fs.writeFileSync(target, original);
  }
  return rows;
});

process.stdout.write(JSON.stringify(out, null, 1) + '\n');
