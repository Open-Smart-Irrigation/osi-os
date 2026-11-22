// Keep test session keys off the command line. Node ships with OpenSSL.
const fs = require('node:fs');
const crypto = require('node:crypto');
const input = fs.readFileSync(0);
const key = input.subarray(0, 16);
const data = input.subarray(16);
function aes(block) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}
function double(block) {
  const out = Buffer.alloc(16);
  let carry = 0;
  for (let n = 15; n >= 0; --n) {
    out[n] = (block[n] << 1) | carry;
    carry = block[n] >>> 7;
  }
  if (carry) out[15] ^= 0x87;
  return out;
}
function cmac(message) {
  const k1 = double(aes(Buffer.alloc(16)));
  const complete = message.length > 0 && message.length % 16 === 0;
  const padded = Buffer.alloc(Math.max(16, Math.ceil(message.length/16)*16));
  message.copy(padded);
  if (!complete) padded[message.length] = 0x80;
  const subkey = complete ? k1 : double(k1);
  for (let i=0; i<16; i++) padded[padded.length-16+i] ^= subkey[i];
  let state = Buffer.alloc(16);
  for (let offset=0; offset<padded.length; offset+=16) {
    for (let i=0; i<16; i++) state[i] ^= padded[offset+i];
    state = aes(state);
  }
  return state;
}
process.stdout.write(process.argv[2] === 'cmac' ? cmac(data) : aes(data));
