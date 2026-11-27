#!/usr/bin/env node
'use strict';
// Content-Type decision vectors for the Node-RED HTTP In body parsers,
// computed by the modules the image ships with Node-RED 3.1.15:
//   body-parser 1.20.3 decides with type-is 1.6.18 (media-typer 0.3.0) and
//   reads the charset with content-type 1.0.5 (try/catch: failure = utf-8);
//   the http-in raw parser uses content-type 1.0.5 and media-typer 1.1.0.
//   node edge/vectors/generate-content-type.js           # writes the vectors
//   node edge/vectors/generate-content-type.js --check   # fails if they would change
// Each header is a latin1 string, as Node decodes header bytes; "hex" holds
// its bytes. "raw" is the raw parser's outcome: "error" (a parse throws),
// "text", "checkutf" or "binary".
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ROOT = path.resolve(__dirname, '../..');
const fixture = Module.createRequire(path.join(ROOT, 'scripts/fixtures/release-smoke/package.json'));
const nodes = Module.createRequire(fixture.resolve('@node-red/nodes/core/network/21-httpin.js'));
const bodyParser = Module.createRequire(fixture.resolve('body-parser/lib/types/json.js'));
const typeis = bodyParser('type-is');
const contentType = bodyParser('content-type');
const rawTyper = nodes('content-type');
const rawMediaTyper = nodes('media-typer');
const version = (req, name) => JSON.parse(fs.readFileSync(req.resolve(name + '/package.json'), 'utf8')).version;
const typeisMediaTyper = Module.createRequire(bodyParser.resolve('type-is'))('media-typer/package.json').version;
const versions = {
  'type-is': version(bodyParser, 'type-is'), 'type-is/media-typer': typeisMediaTyper,
  'body-parser/content-type': version(bodyParser, 'content-type'),
  'http-in/content-type': version(nodes, 'content-type'), 'http-in/media-typer': version(nodes, 'media-typer'),
};
const want = { 'type-is': '1.6.18', 'type-is/media-typer': '0.3.0', 'body-parser/content-type': '1.0.5', 'http-in/content-type': '1.0.5', 'http-in/media-typer': '1.1.0' };
for (const [k, v] of Object.entries(want)) if (versions[k] !== v) throw new Error(k + ' is ' + versions[k] + ', expected ' + v);

function decide(header) {
  const req = { headers: { 'content-type': header, 'content-length': '1' } };
  const json = Boolean(typeis(req, 'application/json'));
  const form = Boolean(typeis(req, 'application/x-www-form-urlencoded'));
  let charset = null;
  try { charset = (contentType.parse(req).parameters.charset || '').toLowerCase(); } catch (e) { charset = null; }
  let raw;
  try {
    const parsed = rawMediaTyper.parse(rawTyper.parse(header).type);
    if (parsed.type === 'text' || parsed.subtype === 'xml' || parsed.suffix === 'xml') raw = 'text';
    else if (parsed.type !== 'application') raw = 'binary';
    else if (!['octet-stream', 'cbor', 'x-protobuf'].includes(parsed.subtype)) raw = 'checkutf';
    else raw = 'binary';
  } catch (e) { raw = 'error'; }
  return { hex: Buffer.from(header, 'latin1').toString('hex'), json, form, charset, raw };
}

const byte = (b) => String.fromCharCode(b);
const headers = new Set([
  'application/json', 'APPLICATION/JSON', 'Application/Json; Charset=UTF-8', 'application/json;', 'application/json; ',
  'application/json ; charset=utf-8', 'application/json  ;charset=utf-8', ' application/json', 'application/json ',
  'application/json\t; charset=utf-8', 'application/json \t; charset=utf-8', 'application/json\t;a=b', '\tapplication/json',
  'application/json ; charset=utf-8', 'application/json ', ' application/json', 'application/json\u0085; charset=utf-8',
  'application/json\u000b; charset=utf-8', 'application/json\u000c; charset=utf-8', 'application/json\u0000',
  'application/json; charset="utf-8"', 'application/json; charset=utf-8; charset=latin1', 'application/json; charset=ISO-8859-1',
  'application/json;charset=', 'application/json; charset', 'application/json; =utf-8', 'application/json;;charset=utf-8',
  'application/json; charset=utf-8;', 'application/json; charset=utf-8 ;', 'application/json; charset = utf-8',
  'application/json; charset=\tutf-8', 'application/json;\tcharset=utf-8', 'application/json; a="b\tc"', 'application/json; a="b\\\tc"',
  'application/json; note="Caf\\é"', 'application/json; note="Café"', 'application/json; a="\\"', 'application/json; a="\\\\"',
  'application/json; a="b"c', 'application/json; a=b c', 'application/json, text/plain',
  'application/json+', 'application/json+json', 'application/x+json', 'application/vnd.osi+json', 'application/a+b+json',
  'application/json+b.c', 'application/json.x', 'application/+json', 'application/json+xml', 'text/json',
  'application/%json', "application/json'", 'application/json*', 'application/js~on', '*/*', 'application/*',
  'application/x-www-form-urlencoded', 'application/x-www-form-urlencoded; charset=utf-8', 'application/x-www-form-urlencoded; charset=UTF8',
  'application/x-www-form-urlencoded\t; charset=utf-8', 'application/x-www-form-urlencoded; note="Caf\\é"',
  'application/x-www-form-urlencoded+', 'application/x-www-form-urlencoded;', 'urlencoded', 'json',
  'text/plain', 'text/plain;', 'text/xml', 'application/xml', 'application/atom+xml', 'application/octet-stream', 'application/cbor',
  'application/x-protobuf', 'image/png', 'multipart/form-data; boundary=x', 'application', 'application/', '/json', 'application//json',
  'a'.repeat(127) + '/json', 'a'.repeat(128) + '/json', 'application/' + 'j'.repeat(127), 'application/' + 'j'.repeat(128),
  'application/' + 'j'.repeat(126) + '+', 'application/json+' + 's'.repeat(127),
]);
for (let b = 0; b < 256; b++) {
  headers.add('application/json; a="x' + byte(b) + 'y"');
  headers.add('application/json; a="x\\' + byte(b) + 'y"');
  headers.add('application/json' + byte(b) + '; charset=utf-8');
  headers.add('application/json; a' + byte(b) + 'b=c');
  headers.add('application/json; a=b' + byte(b) + 'c');
  headers.add('application/js' + byte(b) + 'on');
  headers.add('application/json; charset=utf-8' + byte(b));
}
const vectors = [...headers].map(decide);
const body = { meta: { generator: 'edge/vectors/generate-content-type.js', versions }, vectors };
const file = path.join(__dirname, 'content-type.vectors.json');
const text = JSON.stringify(body, null, 0).replace(/\},\{"hex"/g, '},\n{"hex"') + '\n';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(file, 'utf8') !== text) { console.error('content-type.vectors.json is stale'); process.exit(1); }
} else {
  fs.writeFileSync(file, text);
  console.log('wrote ' + vectors.length + ' vectors');
}
