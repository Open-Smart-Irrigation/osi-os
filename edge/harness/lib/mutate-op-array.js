'use strict';
// Array wrap: [v] and [v,v]. Query and form keys spell an array several ways
// that qs folds together; a backend that reads only the plain key sees a
// scalar in the mixed spelling where qs sees a two-element array.
module.exports = {
  name: 'array-wrap',
  value: (v) => [{ label: '[v]', value: [v] }, { label: '[v,v]', value: [v, v] }],
  pair: (p) => [
    { label: p.base + '[]=v', pairs: [[p.base + '[]', p.value]] },
    { label: p.base + '=v&' + p.base + '=v', pairs: [[p.base, p.value], [p.base, p.value]] },
    { label: p.base + '=v&' + p.base + '[]=v', pairs: [[p.base, p.value], [p.base + '[]', p.value]] },
  ].filter((m) => !(m.pairs.length === 1 && m.pairs[0][0] === p.key)),
};
