'use strict';
const assert = require('node:assert/strict');
const QUERY = 'get-actuations-query';
function assertLoaderReply(id, result, payload = { message: 'Internal error' }) {
  const message = id === QUERY ? result?.[1] : result;
  if (id === QUERY) assert.deepEqual(result, [null, message], 'loader failure must use only error port 2');
  assert.ok(message && !Array.isArray(message), 'loader failure message missing on expected port');
  assert.equal(message.statusCode, 503, 'loader failure status');
  assert.deepEqual(message.payload, payload, 'loader failure payload');
  return message;
}
function assertNativeLoaderReply(id, outputs, expected) {
  const counts = id === QUERY ? [0, 1] : [1];
  assert.deepEqual(outputs.map(port => port.length), counts, 'native loader failure port cardinality');
  const message = outputs[id === QUERY ? 1 : 0][0];
  assertLoaderReply(id, id === QUERY ? [null, message] : message);
  assert.deepEqual(message, id === QUERY ? expected[1] : expected, 'native loader failure exact message');
}
module.exports = { assertLoaderReply, assertNativeLoaderReply };
