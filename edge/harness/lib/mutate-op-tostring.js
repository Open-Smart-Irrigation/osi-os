'use strict';
// toString-object: a JSON object whose own toString is not callable. String(),
// template literals, new Date() and Number() throw on it in JavaScript.
module.exports = {
  name: 'tostring-object',
  value: () => [{ label: '{"toString":0}', value: { toString: 0 } }],
  // qs and body-parser (extended) build the same object from a bracket key.
  pair: (p) => [{ label: p.base + '[toString]=0', pairs: [[p.base + '[toString]', '0']] }],
};
