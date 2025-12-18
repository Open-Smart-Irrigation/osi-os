/**
 * Node-RED Initialization Script for Open Smart Irrigation
 *
 * This file should be required in your Node-RED settings.js:
 *
 * functionGlobalContext: {
 *     ...require('/path/to/react-gui/nodered-backend/init.cjs')
 * }
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

// Database is in the parent directory (react-gui/)
const DB_PATH = path.join(__dirname, '..', 'farming.db');

console.log('═══════════════════════════════════════════════════');
console.log('🌱 Open Smart Irrigation - Node-RED Backend Init');
console.log('═══════════════════════════════════════════════════');
console.log('Database path:', DB_PATH);

// Initialize database connection
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// Test database connection
try {
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
    const deviceCount = db.prepare('SELECT COUNT(*) as count FROM devices').get();

    console.log(`✓ Database connected successfully`);
    console.log(`  └─ ${userCount.count} user(s)`);
    console.log(`  └─ ${deviceCount.count} device(s)`);
} catch (err) {
    console.error('❌ Database connection failed:', err.message);
    console.error('   Make sure farming.db exists in the react-gui directory');
    console.error('   Run: cd nodered-backend && npm run setup');
}

console.log('═══════════════════════════════════════════════════\n');

// Export to Node-RED global context
module.exports = {
    database: db,
    bcrypt: bcrypt,
    jwt: jwt
};
