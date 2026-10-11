import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const sourcePath = resolve(import.meta.dirname, '../../../conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-sdi12-normalize/index.js');
const source = await readFile(sourcePath);
const require = createRequire(import.meta.url);
const {listProfiles} = require(sourcePath);
const profiles = listProfiles();
const hash = createHash('sha256').update(source).digest('hex');
const output = `import type {Sdi12Profile} from '../../src/types/farming';\n\n// Generated from EDGE/osi-sdi12-normalize listProfiles(); source SHA-256: ${hash}\nexport const SDI12_PROFILES: Sdi12Profile[] = ${JSON.stringify(profiles, null, 2)};\n`;
await writeFile(resolve(import.meta.dirname, '../demo/model/sdi12-profiles.ts'), output);
