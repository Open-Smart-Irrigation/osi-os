'use strict';
// Verification-only read overlay: run the real repository gates against the
// rendered handoff, without mutating either reserved repository flow file.
const fs = require('node:fs');
const path = require('node:path');
const original = fs.readFileSync.bind(fs);
const root = process.env.X3_REPO_ROOT;
const scratch = process.env.X3_RENDER_ROOT;
if (!root || !scratch) throw new Error('X3 overlay requires explicit roots');
const mapped = new Map(['bcm2712','bcm2709'].map(profile => {
 const relative = `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`;
 return [path.join(root, relative), path.join(scratch, relative)];
}));
for (const relative of ['scripts/fixtures/silent-catch-baseline.json', 'scripts/verify-no-stray-ddl-baseline.json']) {
 const target = path.join(scratch, relative);
 if (fs.existsSync(target)) mapped.set(path.join(root, relative), target);
}
fs.readFileSync = function(file, ...args) {
 const target = typeof file === 'string' ? mapped.get(path.resolve(file)) : null;
 return original(target || file, ...args);
};
