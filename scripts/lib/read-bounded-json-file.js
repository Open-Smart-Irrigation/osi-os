'use strict';

const fs = require('node:fs');
const MAX_INPUT_BYTES = 1024 * 1024;

function readBoundedJsonFile(filename) {
  let content;
  try {
    // Nonblocking open lets us reject a FIFO without waiting for its writer.
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return { ok: false, code: 'input_not_regular' };
      if (stat.size > MAX_INPUT_BYTES) return { ok: false, code: 'input_too_large' };
      // Bound actual reads too: the file can grow after fstat.
      const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size > MAX_INPUT_BYTES) return { ok: false, code: 'input_too_large' };
      content = buffer.toString('utf8', 0, size);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { ok: false, code: 'input_read_failed' };
  }
  try { return { ok: true, value: JSON.parse(content) }; }
  catch (err) { return { ok: false, code: 'invalid_json' }; }
}

module.exports = { readBoundedJsonFile };
