import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('dependency egress module graph', () => {
  it('keeps the TLS implementation independent from the proxy implementation', async () => {
    const source = await readFile(new URL('../../runner/src/dependency-egress-tls.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/dependency-egress-proxy\.js['"]/u);
  });
});
