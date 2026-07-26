import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const publisherDirectory = join(process.cwd(), 'publisher');

describe('native publisher build contract', () => {
  it('uses the exact C17 warning-as-error compiler contract', async () => {
    const makefile = await readFile(join(publisherDirectory, 'Makefile'), 'utf8');
    expect(makefile).toContain('-std=c17');
    expect(makefile).toContain('-D_GNU_SOURCE');
    expect(makefile).toContain('-O2');
    expect(makefile).toContain('-Wall');
    expect(makefile).toContain('-Wextra');
    expect(makefile).toContain('-Werror');
  });

  it('keeps publication descriptor-relative and no-follow', async () => {
    const source = await readFile(join(publisherDirectory, 'osi-image-publish.c'), 'utf8');
    for (const required of ['openat', 'O_NOFOLLOW', 'O_DIRECTORY', 'fsync', 'renameat2', 'RENAME_NOREPLACE', 'S_ISBLK', 'st_dev', 'fstat(child', 'fstatat(directory, name', 'opened_item', 'errno != 0']) {
      expect(source, required).toContain(required);
    }
    expect(source).toContain('RENAME_NOREPLACE');
    expect(source).toMatch(/renameat2\s*\([^;]+RENAME_NOREPLACE/s);
  });

  it('uses a private self-test tree and does not expose recursive deletion', async () => {
    const source = await readFile(join(publisherDirectory, 'osi-image-publish.c'), 'utf8');
    expect(source).toContain('mkdtemp');
    expect(source).toContain('self-test');
    expect(source).toContain('unlinkat');
    expect(source).not.toMatch(/system\s*\(/);
    expect(source).not.toMatch(/popen\s*\(/);
  });

  it('ships the publisher shell contract for startup checks', async () => {
    const script = await readFile(join(publisherDirectory, 'test-publisher.sh'), 'utf8');
    expect(script).toContain('--version');
    expect(script).toContain('--self-test');
    expect(script).toContain('set -eu');
  });
});
