'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { decodeUplink, encodeValveTask } = require(
  path.resolve(__dirname, '../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/milesight_uc512_decoder.js')
);
const vectors = require('./golden-vectors.json');

describe('UC512 decoder', () => {
  for (const vec of vectors) {
    it(vec.name, () => {
      const result = decodeUplink({ bytes: vec.bytes, fPort: 85 });
      assert.deepEqual(result.data, vec.expected);
    });
  }
});

describe('UC512 downlink encoder', () => {
  it('encodes open valve 1 for 300s', () => {
    const bytes = encodeValveTask({ valve_index: 1, valve_status: 'open', duration: 300, sequence_id: 1 });
    assert.deepEqual(bytes, [0xFF, 0x1D, 1, 1, 0x2C, 0x01, 0x00, 1]);
  });

  it('encodes close valve 2', () => {
    const bytes = encodeValveTask({ valve_index: 2, valve_status: 'close', duration: 0, sequence_id: 5 });
    assert.deepEqual(bytes, [0xFF, 0x1D, 2, 0, 0, 0, 0, 5]);
  });

  it('rejects open without duration (DD17)', () => {
    assert.throws(
      () => encodeValveTask({ valve_index: 1, valve_status: 'open', duration: 0 }),
      /duration must be > 0/
    );
  });

  it('rejects invalid valve_index', () => {
    assert.throws(
      () => encodeValveTask({ valve_index: 3, valve_status: 'close' }),
      /valve_index must be 1 or 2/
    );
  });
});
