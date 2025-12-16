/**
 * Node-RED Initialization Script
 *
 * Add this to your Node-RED settings.js file in the functionGlobalContext section
 * OR create this as a separate file and require it in settings.js
 *
 * This initializes the database connection and required libraries
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

// Database path - UPDATE THIS to match your setup-database.js path
const DB_PATH = path.join(__dirname, 'farming.db');

console.log('Initializing Open Smart irrigation API...');
console.log('Database path:', DB_PATH);

// Initialize database connection
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// Test database connection
try {
    const result = db.prepare('SELECT COUNT(*) as count FROM users').get();
    console.log(`✓ Database connected (${result.count} users)`);
} catch (err) {
    console.error('❌ Database connection failed:', err.message);
    console.error('   Run setup-database.js first!');
}

// Export to Node-RED global context
module.exports = {
    database: db,
    bcrypt: bcrypt,
    jwt: jwt
};
