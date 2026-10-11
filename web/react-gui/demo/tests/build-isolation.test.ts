import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {checkBuildIsolation} from '../check-build-isolation.mjs';

const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function withFixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'osi-demo-isolation-'));
  try {await run(root);} finally {await rm(root, {recursive: true, force: true});}
}

test('production build rejects public simulator credentials and modules', async () => {
  await withFixture(async root => {
    const production = path.join(root, 'build');
    const publicBuild = path.join(root, 'public-demo-build');
    const source = path.join(root, 'src');
    await Promise.all([mkdir(production), mkdir(publicBuild), mkdir(source)]);
    await writeFile(path.join(production, 'index.html'), '<html>production</html>');
    await writeFile(path.join(publicBuild, 'index.html'), '<html>public</html>');
    await writeFile(path.join(publicBuild, 'app.html'), '<html>app</html>');
    await writeFile(path.join(production, 'app.js'), 'inert-demo-session-not-a-jwt demo/runtime.ts');

    const errors = await checkBuildIsolation({production, publicBuild, source});

    assert.ok(errors.some(error => error.includes('demo session marker')), errors.join('\n'));
    assert.ok(errors.some(error => error.includes('simulator modules')), errors.join('\n'));
  });
});

test('production source rejects imports from the demo tree', async () => {
  await withFixture(async root => {
    const production = path.join(root, 'build');
    const publicBuild = path.join(root, 'public-demo-build');
    const source = path.join(root, 'src');
    await Promise.all([mkdir(production), mkdir(publicBuild), mkdir(source)]);
    await writeFile(path.join(production, 'index.html'), '<html>production</html>');
    await writeFile(path.join(publicBuild, 'index.html'), '<html>public</html>');
    await writeFile(path.join(publicBuild, 'app.html'), '<html>app</html>');
    await writeFile(path.join(source, 'entry.ts'), "import '../demo/runtime';\n");

    const errors = await checkBuildIsolation({production, publicBuild, source});

    assert.ok(errors.some(error => error.includes('demo/runtime')), errors.join('\n'));
  });
});

test('production source parses whitespace and comments around literal dynamic imports', async () => {
  await withFixture(async root => {
    const production = path.join(root, 'build');
    const publicBuild = path.join(root, 'public-demo-build');
    const source = path.join(root, 'src');
    await Promise.all([mkdir(production), mkdir(publicBuild), mkdir(source)]);
    await writeFile(path.join(production, 'index.html'), '<html>production</html>');
    await writeFile(path.join(publicBuild, 'index.html'), '<html>public</html>');
    await writeFile(path.join(publicBuild, 'app.html'), '<html>app</html>');
    await writeFile(path.join(source, 'entry.ts'), "export const load = () => import( /* lazy */ '../demo/runtime');\n");

    const errors = await checkBuildIsolation({production, publicBuild, source});

    assert.ok(errors.some(error => error.includes("entry.ts -> ../demo/runtime")), errors.join('\n'));
  });
});

test('production artifacts reject nested simulator module references independently', async () => {
  await withFixture(async root => {
    const production = path.join(root, 'build');
    const publicBuild = path.join(root, 'public-demo-build');
    const source = path.join(root, 'src');
    await Promise.all([mkdir(production), mkdir(publicBuild), mkdir(source)]);
    await writeFile(path.join(production, 'index.html'), '<html>production</html>');
    await writeFile(path.join(production, 'model.js'), 'demo/model/state.ts');
    await writeFile(path.join(production, 'host.js'), 'demo/public/host.ts');
    await writeFile(path.join(publicBuild, 'index.html'), '<html>public</html>');
    await writeFile(path.join(publicBuild, 'app.html'), '<html>app</html>');

    const errors = await checkBuildIsolation({production, publicBuild, source});

    assert.ok(errors.some(error => error.includes('model.js') && error.includes('simulator modules')), errors.join('\n'));
    assert.ok(errors.some(error => error.includes('host.js') && error.includes('simulator modules')), errors.join('\n'));
  });
});

test('public build contains only host and app entry HTML plus local assets', async () => {
  await withFixture(async root => {
    const production = path.join(root, 'build');
    const publicBuild = path.join(root, 'public-demo-build');
    const source = path.join(root, 'src');
    await Promise.all([mkdir(production), mkdir(publicBuild), mkdir(source)]);
    await writeFile(path.join(production, 'index.html'), '<html>production</html>');
    await writeFile(path.join(publicBuild, 'index.html'), '<html>host</html>');
    await writeFile(path.join(publicBuild, 'app.html'), '<html>app</html>');
    await mkdir(path.join(publicBuild, 'assets'));
    await writeFile(path.join(publicBuild, 'assets', 'host.js'), 'host');
    await writeFile(path.join(publicBuild, 'reveal.html'), '<html>presentation</html>');

    const errors = await checkBuildIsolation({production, publicBuild, source});

    assert.ok(errors.some(error => error.includes('reveal.html')), errors.join('\n'));
  });
});

test('clean production and public artifacts pass the isolation checker', async () => {
  await withFixture(async root => {
    const production = path.join(root, 'build');
    const publicBuild = path.join(root, 'public-demo-build');
    const source = path.join(root, 'src');
    await Promise.all([mkdir(production), mkdir(publicBuild), mkdir(source)]);
    await writeFile(path.join(production, 'index.html'), '<html>production</html>');
    await writeFile(path.join(publicBuild, 'index.html'), '<html>host</html>');
    await writeFile(path.join(publicBuild, 'app.html'), '<html>app</html>');
    await mkdir(path.join(publicBuild, 'assets'));
    await writeFile(path.join(publicBuild, 'assets', 'host.js'), 'host');
    await writeFile(path.join(source, 'example.test.ts'), "import '../demo/runtime';\n");
    await mkdir(path.join(source, '__tests__'));
    await writeFile(path.join(source, '__tests__', 'fixture.ts'), "import '../../demo/runtime';\n");

    const errors = await checkBuildIsolation({production, publicBuild, source});

    assert.deepEqual(errors, []);
  });
});
