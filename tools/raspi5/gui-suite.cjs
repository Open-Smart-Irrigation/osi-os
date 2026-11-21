#!/usr/bin/env node
'use strict';

// Isolated, real-browser GUI probes for the locally running candidate image.
// Password is read from stdin and is never placed in argv, page logs, or output.
const readline = require('node:readline');

const USERNAME = 'emulator-admin';
const DURATION_MINUTES = 1;

function args(argv) {
  const [mode, origin, ...rest] = argv;
  if (!['setup', 'open', 'outcome'].includes(mode) || !origin || rest.length > 1) {
    throw new Error('usage: gui-suite.cjs <setup|open|outcome> <loopback-origin> [valve-eui]');
  }
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('origin must use a local loopback host');
  }
  if (url.username || url.password) throw new Error('origin must not contain credentials');
  return { mode, origin: url.origin, eui: rest[0] };
}

function readPassword() {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.once('line', (line) => { line ? resolve(line) : reject(new Error('empty stdin password')); rl.close(); });
    rl.once('close', () => reject(new Error('password not provided on stdin')));
  });
}

async function main() {
  const { mode, origin, eui } = args(process.argv.slice(2));
  if (mode !== 'setup' && !eui) throw new Error(`${mode} requires a valve EUI`);
  const password = await readPassword();
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    if (mode === 'setup') {
      await page.goto(origin+'/gui/#/register');
      await page.locator('#username').fill(USERNAME);
      await page.locator('#password').fill(password);
      await page.locator('#confirmPassword').fill(password);
      await page.locator('button[type=submit]').click();
      await page.waitForURL('**/#/login');
      await login(page, password);
      const token = await page.evaluate(() => localStorage.getItem('auth_token'));
      if (!token) throw new Error('GUI session did not store auth_token');
      const profile = await page.evaluate(async (auth) => {
        const response = await fetch('/api/me', { headers: { Authorization: `Bearer ${auth}` } });
        if (!response.ok) throw new Error(`/api/me returned ${response.status}`);
        return response.json();
      }, token);
      const role = profile.role || profile.effective_role || profile.user?.role;
      if (role !== 'admin' || profile.features?.scoped_access !== false) throw new Error(`synthetic admin role was not observed (role=${String(role)})`);
      console.log(JSON.stringify({ mode, effectiveRole: role, scopedAccess: profile.features?.scoped_access, verified: true }));
      return;
    }
    await login(page, password);
    await page.goto(`${origin}/gui/#/`, { waitUntil: 'domcontentloaded' });
    const input = page.locator(`input[id="strega-duration-${eui}" i]`);
    await input.waitFor();
    if (mode === 'open') {
      await input.fill(String(DURATION_MINUTES));
      const button = input.locator('..').getByRole('button');
      await button.click();
      const [response] = await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname.toUpperCase() === ('/api/valve/'+eui).toUpperCase() && r.request().method() === 'POST'),
        button.click()
      ]);
      if (!response.ok()) throw Error('valve request failed');
      console.log('GUI submitted one-minute open');
    } else {
      const card = input.locator('xpath=ancestor::*[.//p[contains(@class,"tabular-nums")]][1]');
      await card.locator('p.tabular-nums').filter({hasText:/^open$/i}).waitFor();
      console.log('GUI shows reported open state');
    }
  } finally {
    await browser.close();
  }
}

async function login(page, password) {
  await page.goto(new URL('/gui/#/login', page.url() === 'about:blank' ? process.argv[3] : page.url()).href);
  await page.locator('#username').fill(USERNAME);
  await page.locator('#password').fill(password);
  await page.locator('button[type=submit]').click();
  await page.waitForFunction(() => !location.hash.includes('/login'));
}

main().catch(() => { console.error('GUI check failed'); process.exitCode = 1; });
