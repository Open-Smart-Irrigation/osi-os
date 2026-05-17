const { execFileSync } = require('child_process');

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COLUMN_DEFINITION_PATTERN = /^[A-Za-z0-9_ (),.]+$/;

function validateIdentifier(value, label) {
    const normalized = String(value || '').trim();
    if (!IDENTIFIER_PATTERN.test(normalized)) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
    return normalized;
}

function validateColumnDefinition(definition) {
    const normalized = String(definition || '').trim();
    if (!normalized || !COLUMN_DEFINITION_PATTERN.test(normalized)) {
        throw new Error(`Invalid column definition: ${definition}`);
    }
    return normalized;
}

function createSqliteHelpers(dbPath) {
    function sqlite(input) {
        return execFileSync('sqlite3', [dbPath], { input, encoding: 'utf8' });
    }

    function columns(table) {
        const tableName = validateIdentifier(table, 'table name');
        return execFileSync('sqlite3', [dbPath, `PRAGMA table_info(${tableName});`], { encoding: 'utf8' })
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => line.split('|')[1])
            .filter(Boolean);
    }

    function ensureColumn(table, name, definition) {
        const tableName = validateIdentifier(table, 'table name');
        const columnName = validateIdentifier(name, 'column name');
        const columnDefinition = validateColumnDefinition(definition);
        if (columns(tableName).includes(columnName)) {
            console.log(`  ok ${tableName}.${columnName} present`);
            return;
        }
        sqlite(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
        console.log(`  added ${tableName}.${columnName}`);
    }

    return { sqlite, columns, ensureColumn };
}

module.exports = {
    createSqliteHelpers,
    validateIdentifier,
    validateColumnDefinition
};
