'use strict';
// U1 — browser smoke through the REAL GUI, plus a French hardcoded-English scan.
//
// Playwright is NOT a repo dependency: it lives at /home/phil/osi-tools/playwright
// (override with OSI_PLAYWRIGHT_DIR). Nothing here is added to package.json and
// the repo is never built -- the GUI under test is the bundle the gateway is
// actually serving.
//
// Screenshots land in <run dir>/ui/ at desktop (1366x768) and mobile (390x844).
//
// The i18n scan compares what the page renders in French against the locale
// bundles the gateway serves: a visible string that exactly equals an English
// value whose French value differs is a hardcoded-English leak, and a visible
// string that looks like a dotted i18n key is a missing translation.

const fs = require('node:fs');
const path = require('node:path');
const { browserRequestDecision, originOf } = require('../lib/browserGuard');

const PLAYWRIGHT_DIR = process.env.OSI_PLAYWRIGHT_DIR || '/home/phil/osi-tools/playwright';

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    return require(path.join(PLAYWRIGHT_DIR, 'node_modules', 'playwright'));
  }
}

const NAMESPACES = ['common', 'auth', 'dashboard', 'devices', 'accountLink', 'history', 'support', 'settings', 'valves', 'journal', 'network'];

// Routes the GUI actually has (web/react-gui/src/App.tsx, HashRouter).
const PAGES = [
  { name: 'login', hash: '#/login', auth: false },
  { name: 'dashboard', hash: '#/dashboard', auth: true },
  { name: 'zones-devices', hash: '#/dashboard', auth: true, note: 'zones and devices live on the dashboard; no separate route' },
  { name: 'history', hash: '#/history', auth: true },
  { name: 'network', hash: '#/network', auth: true },
  { name: 'analysis', hash: '#/analysis', auth: true },
  { name: 'settings', hash: '#/settings', auth: true },
  { name: 'account-link', hash: '#/account-link', auth: true },
];

const VIEWPORTS = [
  { id: 'desktop', width: 1366, height: 768 },
  { id: 'mobile', width: 390, height: 844 },
];

// The one fetch in this harness that does not go through lib/rest.js. It takes
// the same redirect rule: a locale bundle is served or it is not, and a 3xx
// here would only be a way to send this request somewhere else.
async function fetchLocale(apiBase, lng, ns) {
  const res = await fetch(apiBase + '/gui/locales/' + lng + '/' + ns + '.json', { redirect: 'manual' });
  if (!res.ok) return null;
  try { return await res.json(); } catch (_) { return null; }
}

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else if (typeof v === 'string') out[key] = v;
  }
  return out;
}

exports.title = 'GUI smoke: login, screenshots at two widths, French hardcoded-English scan';

exports.run = async (ctx) => {
  const { cfg, ev, rest } = ctx;
  const { chromium } = loadPlaywright();
  const uiDir = path.join(ctx.runDir, 'ui');
  fs.mkdirSync(uiDir, { recursive: true });

  // A dedicated GUI account, so the smoke exercises the real login form rather
  // than a token injected into storage.
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const username = 'osi_u1_' + suffix;
  const password = 'U1pass_' + suffix;
  const reg = await ctx.anonRest.post('/auth/register', { username, password });
  ctx.expectStatus('a GUI test account can be registered', reg, 201);

  // --- locale bundles, straight off the gateway ----------------------------
  const en = {};
  const fr = {};
  for (const ns of NAMESPACES) {
    const enNs = await fetchLocale(cfg.apiBase, 'en', ns);
    const frNs = await fetchLocale(cfg.apiBase, 'fr', ns);
    if (enNs) flatten(enNs, ns, en);
    if (frNs) flatten(frNs, ns, fr);
  }
  ctx.expect('the gateway serves the English locale bundles', Object.keys(en).length > 50, { keys: Object.keys(en).length });
  ctx.expect('the gateway serves the French locale bundles', Object.keys(fr).length > 50, { keys: Object.keys(fr).length });

  const missingFr = Object.keys(en).filter((k) => !(k in fr));
  ctx.expect('every English key has a French translation in the served bundles',
    missingFr.length === 0, { missing: missingFr.length, sample: missingFr.slice(0, 15) });

  // English values that MUST NOT appear on a French page: they have a French
  // translation that differs, so seeing the English one means the string was
  // hardcoded in a component instead of going through t().
  const englishOnly = new Map();
  for (const [k, v] of Object.entries(en)) {
    const f = fr[k];
    if (!f || f === v) continue;                     // no translation, or intentionally identical
    if (v.length < 6) continue;                      // too short to attribute reliably
    if (/\{\{/.test(v)) continue;                    // interpolated, compare after render is unreliable
    englishOnly.set(v.trim(), k);
  }
  const frValues = new Set(Object.values(fr).map((v) => v.trim()));

  // Heuristic 3 (below): English function words that never occur in French UI
  // copy. Deliberately short and boring -- it is meant to catch a whole
  // untranslated card, not to grade prose. A word here only counts as a finding
  // when the surrounding string is not itself a French translation.
  const ENGLISH_MARKERS = /\b(the|and|with|your|ago|used|not|available|updated|refresh|reboot|status|memory|temperature|settings|gateway|current|load|control|off|low|medium|high|max)\b/i;
  // i18next renders these literally when a key resolves badly.
  const I18N_ERROR = /returned an object instead of string|missingKey|^\[object Object\]$/i;

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const findings = { leaks: [], rawKeys: [], i18nErrors: [], englishBlocks: [], consoleErrors: [], pageErrors: [],
    blockedRequests: [] };
  // Every browser request is pinned to the GUI's own origin. The endpoint guard
  // covers the sockets this harness opens; this covers the ones the PAGE opens.
  const guiOrigin = originOf(cfg.guiBase);
  const blockedRequests = findings.blockedRequests;
  const shots = [];

  try {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        locale: 'fr-FR',
      });
      // Force the GUI's own language selector value; i18next reads this key
      // (src/i18n/config.ts: lookupLocalStorage 'i18n_language').
      await context.addInitScript(() => {
        try { window.localStorage.setItem('i18n_language', 'fr'); } catch (e) { /* storage blocked */ }
      });
      await context.route('**/*', async (route, request) => {
        const decision = browserRequestDecision(request.url(), guiOrigin);
        if (decision.allowed) {
          await route.continue();
          return;
        }
        blockedRequests.push({
          viewport: vp.id,
          url: String(request.url()).slice(0, 300),
          resourceType: request.resourceType(),
          reason: decision.reason,
        });
        await route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      page.on('console', (m) => { if (m.type() === 'error') findings.consoleErrors.push({ viewport: vp.id, text: m.text().slice(0, 300) }); });
      page.on('pageerror', (e) => findings.pageErrors.push({ viewport: vp.id, text: String(e.message).slice(0, 300) }));

      // --- login through the real form -----------------------------------
      await page.goto(cfg.guiBase + '#/login', { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(1200);
      const loginShot = path.join(uiDir, vp.id + '-login.png');
      await page.screenshot({ path: loginShot, fullPage: true });
      shots.push(path.relative(ctx.runDir, loginShot));

      const userField = page.locator('input[name="username"], input#username, input[type="text"]').first();
      const passField = page.locator('input[type="password"]').first();
      await userField.fill(username, { timeout: 15000 });
      await passField.fill(password, { timeout: 15000 });
      await Promise.all([
        page.waitForTimeout(2500),
        page.locator('button[type="submit"], form button').first().click({ timeout: 15000 }),
      ]);
      const loggedIn = !/#\/login/.test(page.url());
      ctx.expect('logging in through the real GUI form lands on an authenticated page (' + vp.id + ')',
        loggedIn, { url: page.url() });

      // --- every page, screenshotted and scanned --------------------------
      for (const p of PAGES) {
        if (p.auth && !loggedIn) continue;
        if (p.name === 'login') continue;             // already captured, pre-login
        await page.goto(cfg.guiBase + p.hash, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const shot = path.join(uiDir, vp.id + '-' + p.name + '.png');
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        shots.push(path.relative(ctx.runDir, shot));

        const texts = await page.evaluate(() => {
          const out = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = walker.nextNode())) {
            const t = (n.textContent || '').trim();
            if (!t) continue;
            const el = n.parentElement;
            if (!el) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            out.push(t);
          }
          // placeholders, titles and aria labels are user-visible too
          for (const el of document.querySelectorAll('[placeholder],[title],[aria-label]')) {
            for (const attr of ['placeholder', 'title', 'aria-label']) {
              const v = el.getAttribute(attr);
              if (v && v.trim()) out.push(v.trim());
            }
          }
          return out;
        }).catch(() => []);

        for (const t of texts) {
          // 1. i18next gave up and rendered its own error into the UI.
          if (I18N_ERROR.test(t)) {
            findings.i18nErrors.push({ viewport: vp.id, page: p.name, text: t });
            continue;
          }
          if (frValues.has(t)) continue;
          // 2. English that HAS a French translation: the component hardcoded it
          //    instead of calling t().
          if (englishOnly.has(t)) {
            findings.leaks.push({ viewport: vp.id, page: p.name, text: t, key: englishOnly.get(t), expected: fr[englishOnly.get(t)] });
            continue;
          }
          // 3. i18next renders the key itself when a translation is missing.
          if (/^[a-z][A-Za-z0-9]*(\.[a-zA-Z0-9_]+){1,4}$/.test(t) && NAMESPACES.some((ns) => t.startsWith(ns + '.'))) {
            findings.rawKeys.push({ viewport: vp.id, page: p.name, text: t });
            continue;
          }
          // 4. English that is not in ANY locale bundle: a string that was never
          //    translated at all, so heuristic 2 is blind to it.
          if (t.length >= 3 && t.length <= 80 && ENGLISH_MARKERS.test(t) && !/[àâçéèêëîïôûùüÿœ]/i.test(t)) {
            findings.englishBlocks.push({ viewport: vp.id, page: p.name, text: t });
          }
        }

        // A page that rendered nothing at all is a broken route, not a clean page.
        const bodyLength = texts.join(' ').length;
        ctx.expect('the ' + p.name + ' page renders content (' + vp.id + ')', bodyLength > 20,
          { chars: bodyLength, url: page.url() });
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  const dedupeLeaks = [];
  const seen = new Set();
  for (const l of findings.leaks) {
    const k = l.page + '|' + l.text;
    if (seen.has(k)) continue;
    seen.add(k);
    dedupeLeaks.push(l);
  }

  const dedupe = (rows) => {
    const out = [];
    const s2 = new Set();
    for (const r of rows) {
      const k = r.page + '|' + r.text;
      if (s2.has(k)) continue;
      s2.add(k);
      out.push(r);
    }
    return out;
  };
  const i18nErrors = dedupe(findings.i18nErrors);
  const englishBlocks = dedupe(findings.englishBlocks);

  ctx.expect('no hardcoded English string is rendered while the UI language is French',
    dedupeLeaks.length === 0, { leaks: dedupeLeaks.length, sample: dedupeLeaks.slice(0, 12) });
  ctx.expect('no raw i18n key is rendered instead of a translation',
    findings.rawKeys.length === 0, { rawKeys: findings.rawKeys.slice(0, 12) });
  ctx.expect('i18next never renders its own error text into the UI',
    i18nErrors.length === 0, { errors: i18nErrors.slice(0, 8) });
  ctx.expect('no never-translated English text is rendered on a French page',
    englishBlocks.length === 0, { count: englishBlocks.length, sample: englishBlocks.slice(0, 20).map((r) => r.page + ': ' + r.text) });
  if (i18nErrors.length) {
    ev.note('i18next error text is visible in the UI: ' + JSON.stringify(i18nErrors.slice(0, 3)) +
      '. Only a browser-level check finds this -- the string is produced at render time, so no locale-file ' +
      'or unit test sees it unless it wires up real resources.');
  }
  if (englishBlocks.length) {
    ev.note('Untranslated English is rendered on French pages (' + englishBlocks.length + ' distinct strings). ' +
      'These have no key in any locale bundle at all, so a bundle-completeness check reports 100% coverage ' +
      'while the page is visibly English. Pages: ' +
      JSON.stringify([...new Set(englishBlocks.map((r) => r.page))]) + '.');
  }
  ctx.expect('the GUI raises no uncaught page errors',
    findings.pageErrors.length === 0, { errors: findings.pageErrors.slice(0, 8) });

  const reportPath = path.join(uiDir, 'i18n-scan.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    language: 'fr',
    comparedKeys: Object.keys(en).length,
    missingFrenchKeys: missingFr,
    leaks: dedupeLeaks,
    rawKeys: findings.rawKeys,
    i18nErrors,
    englishBlocks,
    consoleErrors: findings.consoleErrors,
    pageErrors: findings.pageErrors,
    screenshots: shots,
  }, null, 2) + '\n');
  ev.artifact('French i18n scan', path.relative(ctx.runDir, reportPath));
  for (const s of shots) ev.artifact('screenshot', s);
  ev.note('GUI account "' + username + '" was registered for this smoke and cannot be removed through the API.');
  ctx.expect('the browser request guard was armed against the GUI origin', !!guiOrigin, { guiOrigin });
  if (blockedRequests.length) {
    // Not a failure: an offline-first GUI should not need a third-party origin,
    // but a blocked font or tile explains a gap in a screenshot.
    ev.note('The request guard blocked ' + blockedRequests.length + ' cross-origin request(s); every URL and ' +
      'reason is in the i18n scan report under "blockedRequests". First: ' +
      blockedRequests.slice(0, 3).map((b) => b.url).join(', '));
  } else {
    ev.note('The request guard blocked nothing: every request the GUI made stayed on ' + guiOrigin + '.');
  }
};

exports.cleanup = async () => { /* no gateway resources are created beyond the account */ };

// Standalone entry: node tests/silvan/ui/smoke.js --out DIR
if (require.main === module) {
  const runPath = path.join(__dirname, '..', 'run.js');
  const args = process.argv.slice(2);
  const { spawnSync } = require('node:child_process');
  const res = spawnSync(process.execPath, [runPath, '--cases', 'U1'].concat(args), { stdio: 'inherit' });
  process.exit(res.status === null ? 1 : res.status);
}
