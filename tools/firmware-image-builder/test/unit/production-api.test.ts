import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const productionPath = new URL('../../api/src/production.ts', import.meta.url);

async function productionSource(): Promise<string> {
  return readFile(productionPath, 'utf8');
}

function startupServices(source: string): string {
  const start = source.indexOf('createStartupBootstrap(');
  const end = source.indexOf('const targets:', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('production API assembly contract', () => {
  it('loads the installed builder lock with ESM-safe filesystem APIs', async () => {
    const source = await productionSource();

    expect(source).not.toMatch(/\brequire\s*\(/u);
    expect(source).toMatch(/readLock\s*\([^)]*\)[^{]*\{[\s\S]*?readFile\s*\(/u);
    expect(source).toMatch(/readLock\s*\(/u);
  });

  it('delegates every startup recovery phase to a named production service', async () => {
    const source = await productionSource();
    const services = startupServices(source);

    for (const phase of [
      'migrations',
      'cleanupAdmissions',
      'liveRunnerClassification',
      'stalePublishingRecovery',
      'nonPublishingInterruption',
    ]) {
      const match = services.match(new RegExp(`${phase}\\s*:\\s*([^,}]+)`, 'u'));
      expect(match, `missing startup service ${phase}`).not.toBeNull();
      expect(match?.[1], `${phase} must be a named service, not an inline callback`).not.toMatch(/=>/u);
    }

    expect(services).not.toMatch(/async\s*\(\)\s*=>\s*\(\{\s*blockers\s*:\s*\[\]\s*\}\)/u);
  });

  it('builds health from live filesystem capacity and the installed lock identity', async () => {
    const source = await productionSource();

    expect(source).toMatch(/\bstatfs\s*\(/u);
    expect(source).not.toMatch(/diskFreeBytes\s*:\s*0\b/u);
    expect(source).toMatch(/readLock\s*\(/u);
    expect(source).not.toMatch(/builderImage\s*:\s*null/u);
    expect(source).toMatch(/builderImage\s*:\s*\{[\s\S]{0,240}(?:id|imageId)[\s\S]{0,240}(?:digest|imageDigest)/u);
  });

  it('adapts the durable ownership store to the freshness protocol', async () => {
    const source = await productionSource();
    const freshnessStart = source.indexOf('createApiFreshnessServer(');
    const freshnessEnd = source.indexOf('const retention', freshnessStart);
    expect(freshnessStart).toBeGreaterThanOrEqual(0);
    expect(freshnessEnd).toBeGreaterThan(freshnessStart);
    const freshness = source.slice(freshnessStart, freshnessEnd);

    expect(freshness).not.toMatch(/store\s*:\s*ownership\b/u);
    expect(freshness).toMatch(/store\s*:\s*(?!ownership\b)[A-Za-z_$][\w$]*/u);
    expect(source).toMatch(/(?:const|function)\s+[A-Za-z_$][\w$]*(?:freshness|protocol)[A-Za-z_$\d]*[\s=(:]/iu);
    expect(source).toMatch(/\bgetJob\s*:/u);
    expect(source).toMatch(/\brequest\s*:/u);
    expect(source).toMatch(/\bresult\s*:/u);
  });

  it('routes through a real paginated API job-store adapter', async () => {
    const source = await productionSource();
    const routesStart = source.indexOf('createApiRouteHandler(');
    const routesEnd = source.indexOf('const createHttp', routesStart);
    expect(routesStart).toBeGreaterThanOrEqual(0);
    expect(routesEnd).toBeGreaterThan(routesStart);
    const routes = source.slice(routesStart, routesEnd);

    expect(source).toMatch(/const\s+apiStore\s*=/u);
    expect(source).toMatch(/listJobs\s*:/u);
    expect(routes).toMatch(/store\s*:\s*apiStore\b/u);
    expect(routes).not.toMatch(/store\s*:\s*store\b/u);
  });

  it('keeps SSE streams bound to the requested job root', async () => {
    const source = await productionSource();

    expect(source).toMatch(/openStream\s*:\s*\(jobId\)\s*=>/u);
    expect(source).toMatch(/root\s*:\s*join\([^\n]*\bjobId\b/u);
    expect(source).not.toMatch(/openStream\s*:\s*\(\)\s*=>/u);
  });

  it('resolves migrations and UI from the installed version tree', async () => {
    const source = await productionSource();

    expect(source).toMatch(/migrationsDirectory\s*:\s*join\(packageDirectory,\s*['"]api['"],\s*['"]migrations['"]\)/u);
    expect(source).toMatch(/createStaticUiService\(join\(packageDirectory,\s*['"]ui['"]\)\)/u);
  });

  it('discovers every builder container by the primary job label', async () => {
    const source = await productionSource();
    const start = source.indexOf('listBuilderContainers:');
    const end = source.indexOf('function queueSafety', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const listing = source.slice(start, end);

    expect(listing).toContain("'label=org.osi.image-builder.job-id'");
    expect(listing).not.toContain("'label=org.osi.image-builder.manifest-sha'");
  });
});
