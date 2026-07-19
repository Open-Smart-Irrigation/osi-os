// Canonical v4 UUID generator that works on INSECURE origins.
//
// `crypto.randomUUID()` is only defined in a secure context (HTTPS or
// localhost). OSI gateways serve the GUI over plain `http://<pi-ip>:1880`, an
// insecure origin, where `crypto.randomUUID` is `undefined` — calling it there
// throws "crypto.randomUUID is not a function" and crashes the capture flow.
// `crypto.getRandomValues()` IS available on insecure origins, so fall back to
// a v4 generator built on it (and, as a last resort, on Math.random).
export function randomUuid(): string {
  const c: Crypto | undefined = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  // RFC 4122 §4.4: set version (4) and variant (10xx) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) hex.push(bytes[i].toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}
