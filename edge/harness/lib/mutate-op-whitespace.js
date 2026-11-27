'use strict';
// Whitespace that one trim removes and another keeps. JavaScript's
// String.prototype.trim strips tab, LF, CR, NBSP, U+FEFF and the line and
// paragraph separators; SQLite's trim() strips only U+0020; Go's
// strings.TrimSpace strips U+0085 (NEL), which JavaScript keeps, and keeps
// U+FEFF, which JavaScript strips. A backend that moves a JavaScript trim
// into SQL, or into TrimSpace, then reads a padded or blank value differently
// (dispatch review B2: a tab gateway EUI that Node-RED treats as missing).
// Variants: `pad-*` puts the character around the value (the trimmed value is
// the original); `only-*` replaces the value with the character alone (blank
// after a JavaScript trim, or after TrimSpace for NEL).
// Body values carry into later steps that echo them (as nul-char); a stored
// 16-hex key in a sql step carries like malformed-valve-eui.
const CHARS = { tab: '\t', nbsp: ' ', feff: '﻿', lsep: ' ', crlf: '\r\n', nel: '\u0085' };
const PAD = {
  tab: (s) => CHARS.tab + s + CHARS.tab,
  nbsp: (s) => CHARS.nbsp + s + CHARS.nbsp,
  feff: (s) => CHARS.feff + s,
  lsep: (s) => s + CHARS.lsep,
  crlf: (s) => s + CHARS.crlf,
  nel: (s) => CHARS.nel + s + CHARS.nel,
};
const KEY = /^[0-9A-F]{16}$/i;
function forms(s) {
  const out = [];
  for (const [name, f] of Object.entries(PAD)) out.push(['pad-' + name, f(s)]);
  for (const [name, c] of Object.entries(CHARS)) if (c !== s) out.push(['only-' + name, c]);
  return out;
}
// Column form (a stored value the scenario never wrote as a literal): the
// same characters through char(); `only-*` also fills NULL rows.
const CODES = { tab: [9], nbsp: [160], feff: [65279], lsep: [8232], crlf: [13, 10], nel: [133] };
const ch = (name) => 'char(' + CODES[name].join(',') + ')';
const PAD_SQL = {
  tab: (c) => ch('tab') + ' || ' + c + ' || ' + ch('tab'),
  nbsp: (c) => ch('nbsp') + ' || ' + c + ' || ' + ch('nbsp'),
  feff: (c) => ch('feff') + ' || ' + c,
  lsep: (c) => c + ' || ' + ch('lsep'),
  crlf: (c) => c + ' || ' + ch('crlf'),
  nel: (c) => ch('nel') + ' || ' + c + ' || ' + ch('nel'),
};
const textColumn = (site) => site.affinity === 'TEXT' || site.affinity === 'BLOB';
module.exports = {
  name: 'whitespace-trim',
  column: (site) => (textColumn(site) ? [
    ...Object.entries(PAD_SQL).map(([name, f]) => ({ label: 'pad-' + name, sql: f(site.col) })),
    ...Object.keys(CODES).map((name) => ({ label: 'only-' + name, sql: ch(name), all: true })),
  ] : []),
  value: (v, site) => {
    if (typeof v !== 'string') return [];
    const carry = site && site.container === 'sql' ? (KEY.test(v) ? 'key' : undefined) : true;
    return forms(v).map(([label, value]) => (carry ? { label, value, carry } : { label, value }));
  },
  pair: (p) => forms(p.value).map(([label, value]) => ({ label: p.key + '=' + label, pairs: [[p.key, value]] })),
  CHARS,
};
