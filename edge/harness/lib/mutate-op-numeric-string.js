'use strict';
// Numeric strings that JavaScript's Number() reads differently from a strict
// integer parser: plain, hexadecimal, padded and exponent forms.
const FORMS = ['15', '0x10', ' 15 ', '1e3'];
const numeric = (v) => typeof v === 'number' || (typeof v === 'string' && /^\s*[-+]?(\d|\.\d|0x)/i.test(v));
module.exports = {
  name: 'numeric-string',
  value: (v) => (numeric(v) ? FORMS.filter((f) => f !== v).map((f) => ({ label: JSON.stringify(f), value: f })) : []),
  pair: (p) => (numeric(p.value) ? FORMS.filter((f) => f !== p.value).map((f) => ({ label: p.key + '=' + JSON.stringify(f), pairs: [[p.key, f]] })) : []),
};
