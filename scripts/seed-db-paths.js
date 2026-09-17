'use strict';
// The bundled farming.db seed images, in one place.
//
// Seven copies of the same image ship in the tree: five profile payloads plus
// two dev-convenience copies. deploy.sh picks one of the profile copies by
// hardware model (detect_seed_db_rel) and copies it onto a brand-new gateway.
// They must stay byte-identical - scripts/verify-profile-parity.js compares
// the bcm2712 and bcm2709 payloads byte for byte, and every other consumer
// assumes one schema.
//
// Consumers: scripts/build-seed-db.js (writes them),
// scripts/verify-seed-db-ledger.js and scripts/verify-db-schema-consistency.js
// (read them).
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const SEED_DB_RELATIVE_PATHS = [
  'conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  'conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'database/farming.db',
  'web/react-gui/farming.db',
];

const SEED_DB_PATHS = SEED_DB_RELATIVE_PATHS.map((rel) => path.join(REPO_ROOT, rel));

// The profile copy deploy.sh treats as the canonical source of truth
// (detect_seed_db_rel falls back to it for any unrecognized hardware model).
const CANONICAL_SEED_DB_RELATIVE_PATH = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db';

const MIGRATIONS_DIR = path.join(REPO_ROOT, 'database/migrations/ordered');

module.exports = {
  REPO_ROOT,
  SEED_DB_RELATIVE_PATHS,
  SEED_DB_PATHS,
  CANONICAL_SEED_DB_RELATIVE_PATH,
  MIGRATIONS_DIR,
};
