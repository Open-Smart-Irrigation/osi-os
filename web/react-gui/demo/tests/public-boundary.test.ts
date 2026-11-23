import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {canNavigate, createObjectUrlBoundary, isPresentationActionBlocked, localPngDownloadFromDataUrl, localPngFromDataUrl} from '../public-boundary';

test('presentation-only app actions stay blocked while public simulator actions reach local handlers', () => {
  assert.equal(isPresentationActionBlocked('presentation', 'logout'), true);
  assert.equal(isPresentationActionBlocked('presentation', 'osi-server'), true);
  assert.equal(isPresentationActionBlocked('public', 'logout'), false);
  assert.equal(isPresentationActionBlocked('public', 'osi-server'), false);
});

test('navigation permits only same-app routes and simulator-owned blob URLs', () => {
  const owned = new Set<string>();
  const current = new URL('http://localhost:4173/app.html#/home');
  assert.equal(canNavigate(current, 'http://localhost:4173/app.html#/account-link', owned), true);
  assert.equal(canNavigate(current, 'https://osicloud.ch/login', owned), false);
  assert.equal(canNavigate(current, 'blob:http://localhost:4173/unregistered', owned), false);
  owned.add('blob:http://localhost:4173/registered');
  assert.equal(canNavigate(current, 'blob:http://localhost:4173/registered', owned), false);
  assert.equal(canNavigate(current, 'blob:http://localhost:4173/registered', owned, ''), false);
  assert.equal(canNavigate(current, 'blob:http://localhost:4173/registered', owned, 'report.csv'), true);
  assert.equal(canNavigate(current, 'http://localhost:4173/app.html#/account-link', owned), true);
});

test('object URL boundary registers, revokes, and releases only its own blob URLs', () => {
  let created = 0;
  let revoked = 0;
  const boundary = createObjectUrlBoundary({
    createObjectURL: () => `blob:demo/${++created}`,
    revokeObjectURL: () => {revoked += 1;},
  });
  const url = boundary.create({} as Blob);
  assert.equal(boundary.owns(url), true);
  boundary.revoke(url);
  assert.equal(boundary.owns(url), false);
  const another = boundary.create({} as Blob);
  boundary.releaseAll();
  assert.equal(boundary.owns(another), false);
  assert.equal(revoked, 2);
});

test('only a locally generated PNG data URL with PNG bytes can be normalized for download', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const blob = localPngFromDataUrl(png);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'image/png');
  assert.equal(localPngFromDataUrl('data:image/png;base64,SGVsbG8='), null);
  assert.equal(localPngFromDataUrl('data:text/plain;base64,SGVsbG8='), null);
  assert.equal(localPngDownloadFromDataUrl(png, ''), null);
  assert.equal(localPngDownloadFromDataUrl(png, 'map.png')?.type, 'image/png');
  const truncated = new Uint8Array(24);
  truncated.set([137, 80, 78, 71, 13, 10, 26, 10]);
  new DataView(truncated.buffer).setUint32(8, 13);
  truncated.set([73, 72, 68, 82], 12);
  new DataView(truncated.buffer).setUint32(16, 1);
  new DataView(truncated.buffer).setUint32(20, 1);
  const truncatedUrl = `data:image/png;base64,${btoa(String.fromCharCode(...truncated))}`;
  assert.equal(localPngFromDataUrl(truncatedUrl), null);
});

test('experimental modules and flow-meter hint are scoped to the presentation root', async () => {
  const css = await readFile(resolve(import.meta.dirname, '../app.css'), 'utf8');
  const runtime = await readFile(resolve(import.meta.dirname, '../runtime.ts'), 'utf8');
  assert.match(css, /#root\[data-public-simulator="false"\].*data-experimental-module/s);
  assert.match(css, /#root\[data-public-simulator="false"\].*flow-meter/s);
  assert.match(runtime, /if\s*\(!publicMode\)\s*localStorage\.setItem\('osi\.modules\.environment',\s*'false'\)/);
});
