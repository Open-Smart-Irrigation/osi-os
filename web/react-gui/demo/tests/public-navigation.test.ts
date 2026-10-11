import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {createObjectUrlBoundary} from '../public-boundary';
import {installDemoNavigationGuard} from '../public-navigation';

test('runtime navigation guard distinguishes route links from owned download links in the DOM', () => {
  const dom = new JSDOM('<!doctype html><a id="route" href="/app.html#/settings">Settings</a>', {url: 'http://localhost/app.html#/home'});
  let nextUrl = 0;
  const boundary = createObjectUrlBoundary({
    createObjectURL: () => `blob:http://localhost/owned-${++nextUrl}`,
    revokeObjectURL: () => {},
  });
  let blocked = 0;
  installDemoNavigationGuard(dom.window.document, () => new URL(dom.window.location.href), 'public', boundary, () => {blocked++;});
  const guardAllows: boolean[] = [];
  dom.window.document.addEventListener('click', event => {
    guardAllows.push(!event.defaultPrevented);
    event.preventDefault();
  });
  const click = (element: HTMLAnchorElement) => {
    element.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, cancelable: true}));
    return guardAllows.at(-1);
  };

  const route = dom.window.document.querySelector<HTMLAnchorElement>('#route')!;
  assert.equal(click(route), true);

  const blobWithoutName = dom.window.document.createElement('a');
  blobWithoutName.href = boundary.create(new Blob(['download']))
  dom.window.document.body.append(blobWithoutName);
  assert.equal(click(blobWithoutName), false);

  const blobDownload = dom.window.document.createElement('a');
  blobDownload.href = boundary.create(new Blob(['download']));
  blobDownload.download = 'report.csv';
  dom.window.document.body.append(blobDownload);
  assert.equal(click(blobDownload), true);

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const pngWithoutName = dom.window.document.createElement('a');
  pngWithoutName.href = png;
  dom.window.document.body.append(pngWithoutName);
  assert.equal(click(pngWithoutName), false);
  assert.equal(pngWithoutName.href, png);

  const pngDownload = dom.window.document.createElement('a');
  pngDownload.href = png;
  pngDownload.download = 'chart.png';
  dom.window.document.body.append(pngDownload);
  assert.equal(click(pngDownload), true);
  assert.match(pngDownload.href, /^blob:http:\/\/localhost\/owned-/);
  assert.equal(boundary.owns(pngDownload.href), true);
  assert.equal(blocked, 2);
});
