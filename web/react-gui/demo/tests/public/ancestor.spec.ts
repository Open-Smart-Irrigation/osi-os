import {expect, test} from '@playwright/test';

test.beforeEach(async ({page}, testInfo) => {
  if (!testInfo.project.name.startsWith('firefox')) return;
  await page.route(/^http:\/\/[a-z0-9.-]+\.osi\.test:4174\//i, async route => {
    const original = new URL(route.request().url());
    const local = new URL(original);
    local.hostname = '127.0.0.1';
    local.searchParams.set('__ancestor_host', original.hostname);
    await route.fulfill({response: await route.fetch({url: local.href})});
  });
});

const scenarios = [
  {name: 'same-origin Apache policy', target: 'same', parent: 'same.osi.test'},
  {name: 'production subdomain Apache policy', target: 'production', parent: 'website.osi.test'},
  {name: 'staging subdomain Apache policy', target: 'staging', parent: 'staging.osi.test'},
] as const;

for (const scenario of scenarios) {
  test(`${scenario.name} accepts a permitted full outer-to-app chain`, async ({page}) => {
    await page.goto(`http://${scenario.parent}:4174/__ancestor/outer.html?target=${scenario.target}`);
    await expect(page.frameLocator('#wrapper').frameLocator('#simulator').frameLocator('#app')
      .getByRole('heading', {name: 'OSI OS Dashboard'})).toBeVisible({timeout: 20_000});
  });

  test(`${scenario.name} rejects an attacker above an otherwise permitted parent`, async ({page, request}) => {
    const simulatorOrigin = scenario.target === 'same'
      ? 'same.osi.test'
      : scenario.target === 'production' ? 'simulator.osi.test' : 'simulator-staging.osi.test';
    const refusalEvidence: string[] = [];
    const appNavigationRequests: string[] = [];
    const appAssetRequests: string[] = [];
    const cspRefusal = /frame-ancestors|refused to frame|blocked by response|CSP_FRAME_ANCESTOR/i;
    page.on('console', message => {
      if (cspRefusal.test(message.text())) refusalEvidence.push(`browser console: ${message.text()}`);
    });
    page.on('request', pageRequest => {
      const url = new URL(pageRequest.url());
      if (url.hostname !== simulatorOrigin) return;
      if (url.pathname === '/simulator/app.html' && pageRequest.isNavigationRequest()) {
        appNavigationRequests.push(pageRequest.url());
      }
      if (url.pathname.startsWith('/simulator/assets/')) appAssetRequests.push(pageRequest.url());
    });
    page.on('requestfailed', failedRequest => {
      const url = new URL(failedRequest.url());
      const reason = failedRequest.failure()?.errorText ?? '';
      if (url.hostname === simulatorOrigin && url.pathname === '/simulator/app.html' && cspRefusal.test(reason)) {
        refusalEvidence.push(`app navigation cancelled by CSP: ${reason}`);
      }
    });

    // Firefox may cancel the blocked navigation before it emits a page response event.
    // Prove the app document exists and carries the template selected for this host
    // independently of the browser's cancellation event.
    const appDocument = await request.get(`/simulator/app.html?__ancestor_host=${simulatorOrigin}`);
    expect(appDocument.status()).toBe(200);
    expect(appDocument.headers()['content-type']).toMatch(/^text\/html\b/i);
    const policy = appDocument.headers()['content-security-policy'];
    expect(policy).toBeTruthy();
    const frameAncestors = policy!.split(';').map(directive => directive.trim())
      .find(directive => directive.startsWith('frame-ancestors '));
    expect(frameAncestors, 'app response includes the selected frame-ancestors policy').toBeTruthy();
    const allowedAncestors = frameAncestors!.slice('frame-ancestors '.length).split(/\s+/);
    const permittedParent = scenario.target === 'same'
      ? "'self'"
      : `http://${scenario.parent}:4174`;
    expect(allowedAncestors, 'the app policy permits its immediate wrapper parent').toContain(permittedParent);
    expect(allowedAncestors).not.toContain('http://attacker.osi.test:4174');

    await page.goto(`http://attacker.osi.test:4174/__ancestor/outer.html?target=${scenario.target}&wrap=${scenario.parent}&document=app`);
    const wrapper = page.frames().find(frame => frame.url().includes('/__ancestor/wrapper.html'));
    expect(wrapper && new URL(wrapper.url()).hostname).toBe(scenario.parent);
    await expect.poll(() => refusalEvidence.join('\n'), {timeout: 8_000})
      .toMatch(cspRefusal);
    expect(appNavigationRequests, 'the browser attempted the nested app document').not.toHaveLength(0);
    // Firefox leaves a blank child frame after CSP refusal; querying its document can hang.
    const rejectedAppFrame = page.frames().find(frame => frame.parentFrame() === wrapper);
    expect(rejectedAppFrame, 'the wrapper contains the rejected app browsing context').toBeTruthy();
    expect(rejectedAppFrame!.url(), 'the refused app document was not committed into its frame')
      .not.toContain('/simulator/app.html');
    expect(appAssetRequests, 'the refused document did not load simulator app assets').toEqual([]);
  });
}
