#!/usr/bin/env node
'use strict';
// Exports Node's bundled root certificates (tls.rootCertificates) for cloud
// broker TLS verification in the Go edge backend. Run it with the Node
// version the gateway runs (Node-RED's Node, 20.18.3 today):
//   ~/.local/node-v20.18.3-linux-x64/bin/node edge/vectors/generate-node-roots.js
//   ... generate-node-roots.js --check   # fails if the files would change
// Writes edge/go/internal/noderoots/node-v<version>-roots.pem (embedded in
// Go) and edge/vectors/node-roots.vectors.json (SHA-256 of each DER, sorted).
// A Node version change regenerates both and goes through the delta log.
const fs = require('node:fs'), path = require('node:path'), tls = require('node:tls'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const version = process.versions.node;
const pemFile = path.join(ROOT, 'edge/go/internal/noderoots', 'node-v' + version + '-roots.pem');
const vectorFile = path.join(ROOT, 'edge/vectors/node-roots.vectors.json');

const roots = tls.rootCertificates.map((pem) => pem.trim() + '\n');
const fingerprints = roots.map((pem) => new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase()).sort();
const pem = roots.join('');
const vectors = JSON.stringify({ node: version, count: roots.length, sha256: fingerprints }, null, 1) + '\n';

if (process.argv.includes('--check')) {
  const same = fs.existsSync(pemFile) && fs.readFileSync(pemFile, 'utf8') === pem && fs.readFileSync(vectorFile, 'utf8') === vectors;
  console.log(same ? 'node roots: up to date (' + roots.length + ')' : 'node roots: would change');
  process.exitCode = same ? 0 : 1;
} else {
  fs.writeFileSync(pemFile, pem);
  fs.writeFileSync(vectorFile, vectors);
  console.log('wrote', roots.length, 'roots from Node', version);
}
