#!/usr/bin/node
'use strict';
const http = require('node:http');
const { readStatus } = require('./osi-image-safety');
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function createServer(root = '/') {
  return http.createServer((req, res) => {
    let reason = 'Image initialization is incomplete or its state cannot be verified.';
    try { const state = readStatus(root); if (state) reason = state.reason; }
    catch (e) { console.error('Cannot read image initialization status: ' + e.message); }
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
    res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gateway recovery required</title><h1>Gateway recovery required</h1><p>' + escape(reason) + '</p><p>The application is held to protect the farm. Registration is unavailable. An image upgrade can erase farm data and does not prove that kept database files are complete.</p><p>From the root console, restore a verified backup with operator assistance, or deliberately factory reset using <code>osi-factory-reset --erase-farm-and-radio-state</code>. Reset clears farm history, accounts, ChirpStack devices and keys, and local configuration. Neither recovery action is available through this page.</p><p>Use <code>deploy.sh</code> for application upgrades. The initialization step and reason are in <code>/etc/osi-image-initialization.json</code>.</p></html>');
  });
}
module.exports = { createServer };
if (require.main === module) createServer().listen(1880);
