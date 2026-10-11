import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {checkBuildIsolation} from '../check-build-isolation.mjs';

type Fixture = {root: string; production: string; publicBuild: string; source: string};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'osi-demo-isolation-'));
  const fixture = {
    root,
    production: path.join(root, 'build'),
    publicBuild: path.join(root, 'public-demo-build'),
    source: path.join(root, 'src'),
  };
  try {
    await Promise.all([mkdir(fixture.production), mkdir(fixture.publicBuild), mkdir(fixture.source)]);
    await writeFile(path.join(fixture.production, 'index.html'), '<html><script src="/assets/app.js"></script></html>');
    await mkdir(path.join(fixture.production, 'assets'));
    await writeFile(path.join(fixture.production, 'assets', 'app.js'), 'compiled production application');
    await writeFile(path.join(fixture.publicBuild, 'index.html'), '<html>host</html>');
    await writeFile(path.join(fixture.publicBuild, 'app.html'), '<html>app</html>');
    await writeFile(path.join(fixture.source, 'main.jsx'), 'export const entry = true;');
    await writeFile(path.join(fixture.source, 'helper.js'), 'export const helper = true;');
    await run(fixture);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

test('production build rejects public simulator credentials and modules', async () => {
  await withFixture(async ({production, publicBuild, source}) => {
    await writeFile(path.join(production, 'assets', 'app.js'), 'inert-demo-session-not-a-jwt demo/runtime.ts');

    const errors = await checkBuildIsolation({production, publicBuild, source});

    assert.ok(errors.some(error => error.includes('demo session marker')), errors.join('\n'));
    assert.ok(errors.some(error => error.includes('simulator modules')), errors.join('\n'));
  });
});

test('production source rejects imports from the demo tree', async () => {
  await withFixture(async ({production, publicBuild, source}) => {
    await writeFile(path.join(source, 'main.jsx'), "import '../demo/runtime';\n");

    const errors = await checkBuildIsolation({production, publicBuild, source});

    assert.ok(errors.some(error => error.includes('demo/runtime')), errors.join('\n'));
  });
});

test('production source parses whitespace and comments around literal dynamic imports', async () => {
  await withFixture(async ({production, publicBuild, source}) => {
    await writeFile(path.join(source, 'main.jsx'), "export const load = () => import( /* lazy */ '../demo/runtime');\n");

    const errors = await checkBuildIsolation({production, publicBuild, source});

    assert.ok(errors.some(error => error.includes("main.jsx -> ../demo/runtime")), errors.join('\n'));
  });
});

test('production artifacts reject nested simulator module references independently', async () => {
  await withFixture(async ({production, publicBuild, source}) => {
    await writeFile(path.join(production, 'model.js'), 'demo/model/state.ts');
    await writeFile(path.join(production, 'host.js'), 'demo/public/host.ts');

    const errors = await checkBuildIsolation({production, publicBuild, source});

    assert.ok(errors.some(error => error.includes('model.js') && error.includes('simulator modules')), errors.join('\n'));
    assert.ok(errors.some(error => error.includes('host.js') && error.includes('simulator modules')), errors.join('\n'));
  });
});

test('public build contains only host and app entry HTML plus local assets', async () => {
  await withFixture(async ({production, publicBuild, source}) => {
    await mkdir(path.join(publicBuild, 'assets'));
    await writeFile(path.join(publicBuild, 'assets', 'host.js'), 'host');
    await writeFile(path.join(publicBuild, 'reveal.html'), '<html>presentation</html>');

    const errors = await checkBuildIsolation({production, publicBuild, source});

    assert.ok(errors.some(error => error.includes('reveal.html')), errors.join('\n'));
  });
});

test('clean minimal production and public artifacts pass the isolation checker', async () => {
  await withFixture(async ({production, publicBuild, source}) => {
    await mkdir(path.join(publicBuild, 'assets'));
    await writeFile(path.join(publicBuild, 'assets', 'host.js'), 'host');
    await mkdir(path.join(source, '__tests__'));
    await writeFile(path.join(source, '__tests__', 'fixture.ts'), "import '../../demo/runtime';\n");

    const errors = await checkBuildIsolation({production, publicBuild, source});

    assert.deepEqual(errors, []);
  });
});

test('build isolation rejects missing or empty input directories', async t => {
  for (const input of ['production', 'publicBuild', 'source'] as const) {
    for (const state of ['missing', 'empty'] as const) {
      await t.test(`${input} directory is ${state}`, async () => {
        await withFixture(async fixture => {
          const directory = fixture[input];
          await rm(directory, {recursive: true, force: true});
          if (state === 'empty') await mkdir(directory);

          const errors = await checkBuildIsolation(fixture);

          const label = input === 'publicBuild' ? 'public build' : input === 'production' ? 'production build' : 'source';
          assert.ok(errors.some(error => error.toLowerCase().includes(label)
            && (state === 'missing' ? error.includes('missing') : error.includes('empty') || input === 'publicBuild' && error.includes('missing'))), errors.join('\n'));
        });
      });
    }
  }
});

test('build isolation requires a nonempty production HTML entry and compiled JavaScript', async t => {
  await t.test('rejects missing production index.html', async () => {
      await withFixture(async ({production, publicBuild, source}) => {
        await rm(path.join(production, 'index.html'));
        const errors = await checkBuildIsolation({production, publicBuild, source});
        assert.ok(errors.some(error => error.includes('index.html') && error.includes('missing')), errors.join('\n'));
      });
  });
  await t.test('rejects missing compiled production JavaScript', async () => {
    await withFixture(async ({production, publicBuild, source}) => {
      await rm(path.join(production, 'assets', 'app.js'));
      const errors = await checkBuildIsolation({production, publicBuild, source});
      assert.ok(errors.some(error => error.includes('compiled production JavaScript') && error.includes('missing')), errors.join('\n'));
    });
  });
  await t.test('rejects empty production index.html', async () => {
      await withFixture(async ({production, publicBuild, source}) => {
        await writeFile(path.join(production, 'index.html'), '');
        const errors = await checkBuildIsolation({production, publicBuild, source});
        assert.ok(errors.some(error => error.includes('index.html') && error.includes('empty')), errors.join('\n'));
      });
  });
  await t.test('rejects empty compiled production JavaScript', async () => {
    await withFixture(async ({production, publicBuild, source}) => {
      await writeFile(path.join(production, 'assets', 'app.js'), '');
      const errors = await checkBuildIsolation({production, publicBuild, source});
      assert.ok(errors.some(error => error.includes('compiled production JavaScript') && error.includes('empty')), errors.join('\n'));
    });
  });
});

test('build isolation requires nonempty source and public entry files', async t => {
  for (const entry of ['main.jsx', 'index.html', 'app.html'] as const) {
    for (const state of ['missing', 'empty'] as const) {
      await t.test(`${entry} is ${state}`, async () => {
        await withFixture(async ({production, publicBuild, source}) => {
          const directory = entry === 'main.jsx' ? source : publicBuild;
          const file = path.join(directory, entry);
          if (state === 'missing') await rm(file);
          else await writeFile(file, '');
          const errors = await checkBuildIsolation({production, publicBuild, source});
          assert.ok(errors.some(error => error.includes(entry) && error.includes(state)), errors.join('\n'));
        });
      });
    }
  }
});
