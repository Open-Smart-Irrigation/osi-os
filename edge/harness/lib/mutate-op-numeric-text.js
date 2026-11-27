'use strict';
// Numeric text that JavaScript's Number() reads as the original number and a
// strict parser (Go strconv, SQLite's numeric affinity) does not, or the
// other way round: padded with spaces, with a tab and LF, with NBSP, a plus
// sign, hexadecimal and exponent notation. Unlike numeric-string, each form
// keeps the original value, so any difference is a parsing difference.
// Fits numbers and decimal strings. In a sql step SQLite converts text that
// is a well-formed number back to that number when the column has INTEGER,
// REAL or NUMERIC affinity (leading and trailing ASCII spaces, tab and LF
// included, a plus sign and exponent notation too), so those variants would
// store the original value; only `nbsp` and `hex` stay text there.
const DECIMAL = /^-?\d+(\.\d+)?$/;
const STAY_TEXT = new Set(['nbsp', 'hex']);
function forms(v) {
  const s = typeof v === 'number' ? String(v) : v;
  const n = Number(s);
  if (!Number.isFinite(n)) return [];
  const out = [['pad-space', ' ' + s + ' '], ['pad-tab', '\t' + s + '\n'], ['nbsp', ' ' + s]];
  if (!s.startsWith('-')) out.push(['plus', '+' + s]);
  if (Number.isSafeInteger(n) && n >= 0) out.push(['hex', '0x' + n.toString(16).toUpperCase()]);
  out.push(['exp', n.toExponential()]);
  return out.filter(([, f]) => f !== s);
}
const fits = (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && DECIMAL.test(v));
module.exports = {
  name: 'numeric-text',
  // Column form, numeric columns only: the stored number as NBSP-led text
  // and, for a non-negative integer, as hexadecimal text.
  column: (site) => (/^(INTEGER|REAL|NUMERIC)$/.test(site.affinity || '') ? [
    { label: 'nbsp', sql: 'CASE WHEN typeof(' + site.col + ") IN ('integer','real') THEN char(160) || " + site.col + ' ELSE ' + site.col + ' END' },
    { label: 'hex', sql: 'CASE WHEN typeof(' + site.col + ") = 'integer' AND " + site.col + " >= 0 THEN printf('0x%X', " + site.col + ') ELSE ' + site.col + ' END' },
  ] : []),
  value: (v, site) => {
    if (!fits(v)) return [];
    const numericColumn = site && site.container === 'sql' && /^(INTEGER|REAL|NUMERIC)$/.test(site.affinity || '');
    return forms(v).filter(([label]) => !numericColumn || STAY_TEXT.has(label)).map(([label, value]) => ({ label, value }));
  },
  pair: (p) => (fits(p.value) ? forms(p.value).map(([label, value]) => ({ label: p.key + '=' + label, pairs: [[p.key, value]] })) : []),
  forms,
};
