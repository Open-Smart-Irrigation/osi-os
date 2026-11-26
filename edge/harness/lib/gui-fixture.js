'use strict';
const fs = require('node:fs');
const path = require('node:path');

function guiFixture(run) {
  const root = path.join(run, 'gui');
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
  const date = new Date('2024-01-01T00:00:00Z');
  for (const [name, body] of Object.entries({
    'index.html': '<!doctype html><title>Farm GUI</title>\n',
    'app.js': 'console.log("Farm GUI");\n',
    'app.css': 'body { color: green; }\n',
    'app.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    'app.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'),
    'app.woff2': Buffer.from('774f463200ff0080', 'hex'),
    'app.js.map': '{"version":3,"sources":[],"mappings":""}\n',
    'app.json': '{"farm":"synthetic"}\n',
    'nested/index.html': '<p>Nested</p>\n',
    '.hidden': 'ignored\n',
    'unknown.ext-osi-fixture': 'octet stream\n',
  })) {
    const file = path.join(root, name);
    fs.writeFileSync(file, body);
    fs.utimesSync(file, date, date);
  }
  fs.writeFileSync(path.join(run, 'outside.txt'), 'outside the GUI root\n');
  return root;
}

module.exports = { guiFixture };
