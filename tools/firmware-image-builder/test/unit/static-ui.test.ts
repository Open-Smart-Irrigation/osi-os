import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  StaticUiError,
  createStaticUiService,
} from '../../api/src/static-ui.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'osi-static-ui-'));
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<!doctype html><main>builder</main>');
  await writeFile(join(dist, 'assets', 'app.js'), 'console.log("builder");');
  await writeFile(join(dist, 'assets', 'app.css'), 'body { color: black; }');
  return { root, dist };
}

describe('static UI resolver', () => {
  it('fails startup when the built UI root does not exist', () => {
    expect(() => createStaticUiService('/definitely/missing/osi-ui-dist')).toThrowError(
      expect.objectContaining<Partial<StaticUiError>>({ code: 'STATIC_UI_ROOT_UNAVAILABLE' }),
    );
  });

  it('fails startup when the configured UI root is a symlink', async () => {
    const { root, dist } = await fixture();
    const link = join(root, 'dist-link');
    await symlink(dist, link);

    expect(() => createStaticUiService(link)).toThrowError(
      expect.objectContaining<Partial<StaticUiError>>({ code: 'STATIC_UI_ROOT_UNSAFE' }),
    );
  });

  it('serves only known regular files with explicit content types', async () => {
    const { dist } = await fixture();
    const service = createStaticUiService(dist);
    try {
      await expect(service.resolve('/')).resolves.toMatchObject({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        bytes: Buffer.from('<!doctype html><main>builder</main>'),
      });
      await expect(service.resolve('/assets/app.js')).resolves.toMatchObject({
        contentType: 'text/javascript; charset=utf-8',
      });
      await expect(service.resolve('/assets/app.css')).resolves.toMatchObject({
        contentType: 'text/css; charset=utf-8',
      });
      await expect(service.resolve('/assets/missing.js')).resolves.toBeNull();
      await expect(service.resolve('/arbitrary/file.txt')).resolves.toBeNull();
    } finally {
      service.close();
    }
  });

  it.each([
    '/../secret',
    '/assets/../secret',
    '/assets/%2e%2e/secret',
    '/assets\\app.js',
    '//assets/app.js',
  ])('rejects unsafe path %s inside the resolver boundary', async (path) => {
    const { dist } = await fixture();
    const service = createStaticUiService(dist);
    try {
      await expect(service.resolve(path)).rejects.toMatchObject({ code: 'STATIC_UI_PATH_UNSAFE' });
    } finally {
      service.close();
    }
  });

  it('refuses to follow a final or intermediate symlink outside the built tree', async () => {
    const { root, dist } = await fixture();
    const outside = join(root, 'outside.js');
    await writeFile(outside, 'secret');
    await symlink(outside, join(dist, 'assets', 'outside.js'));
    await symlink(root, join(dist, 'assets', 'linked'));
    const service = createStaticUiService(dist);
    try {
      await expect(service.resolve('/assets/outside.js')).rejects.toMatchObject({ code: 'STATIC_UI_PATH_UNSAFE' });
      await expect(service.resolve('/assets/linked/outside.js')).rejects.toMatchObject({ code: 'STATIC_UI_PATH_UNSAFE' });
    } finally {
      service.close();
    }
  });

  it('defers closing the held root descriptor until an active resolution finishes', async () => {
    const { dist } = await fixture();
    await writeFile(join(dist, 'assets', 'large.js'), Buffer.alloc(1024 * 1024, 0x61));
    const service = createStaticUiService(dist);

    const inFlight = service.resolve('/assets/large.js');
    service.close();

    await expect(inFlight).resolves.toMatchObject({ status: 200 });
    await expect(service.resolve('/assets/app.js')).rejects.toMatchObject({ code: 'STATIC_UI_ROOT_UNAVAILABLE' });
    service.close();
  });
});
