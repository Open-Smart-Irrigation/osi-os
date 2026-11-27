'use strict';
// Legacy date spellings that JavaScript's Date parser accepts beyond ISO 8601,
// built from the same instant as the original value.
const DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const pad = (n) => String(n).padStart(2, '0');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function instant(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1e12 && v <= 4e12) return v;
  if (typeof v !== 'string' || !DATE.test(v)) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00:00Z' : v.replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}
function forms(t) {
  const d = new Date(t), p = new Date(t - 8 * 3600000);
  const ymd = (x, s) => x.getUTCFullYear() + s + pad(x.getUTCMonth() + 1) + s + pad(x.getUTCDate());
  const hms = (x) => pad(x.getUTCHours()) + ':' + pad(x.getUTCMinutes()) + ':' + pad(x.getUTCSeconds());
  return [
    ymd(d, '/') + ' ' + hms(d) + ' GMT',
    ymd(d, '-') + 'Z',
    DOW[p.getUTCDay()] + ', ' + pad(p.getUTCDate()) + ' ' + MON[p.getUTCMonth()] + ' ' + p.getUTCFullYear() + ' ' + hms(p) + ' PST',
    ymd(d, '-') + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + 'Z',
  ];
}
module.exports = {
  name: 'legacy-date',
  value: (v) => { const t = instant(v); return t === null ? [] : forms(t).map((f) => ({ label: JSON.stringify(f), value: f })); },
  pair: (p) => { const t = instant(p.value); return t === null ? [] : forms(t).map((f) => ({ label: p.key + '=' + JSON.stringify(f), pairs: [[p.key, f]] })); },
  forms, instant,
};
