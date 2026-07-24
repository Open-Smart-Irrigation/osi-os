#!/usr/bin/env node
// Validates contract schema correctness for known edge cases.
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');

const SCHEMA_DIR = path.resolve(__dirname, '../docs/contracts/sync-schema');
const STAGING_MANIFEST = path.resolve(__dirname, 'fixtures/sync-contract-staging.json');
const JOURNAL_AGGREGATE = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/aggregate');
const UUID = '12345678-1234-4234-8234-123456789abc';
const COMPACT_UUID = '12345678123442348234123456789abc';
const JOURNAL_COMMANDS = [
    'UPSERT_JOURNAL_ENTRY',
    'VOID_JOURNAL_ENTRY',
    'UPSERT_JOURNAL_CUSTOM_VOCAB',
    'UPSERT_JOURNAL_PLOT',
    'UPSERT_JOURNAL_PLOT_GROUP',
];
const SCOPED_ACCESS_COMMANDS = [
    'UPSERT_SCOPED_USER',
    'RESET_SCOPED_USER_PASSWORD',
    'UPSERT_USER_ZONE_ASSIGNMENT',
    'DELETE_USER_ZONE_ASSIGNMENT',
    'UPSERT_USER_PLOT_ASSIGNMENT',
    'DELETE_USER_PLOT_ASSIGNMENT',
];
const ZONE_COMMANDS = [
    'UPSERT_ZONE',
    'DELETE_ZONE',
    'UPSERT_ZONE_CONFIG',
    'UPSERT_ZONE_LOCATION',
];
const IRRIGATION_CONFIG_COMMANDS = [
    'UPSERT_SCHEDULE',
    'UPSERT_ZONE_IRRIGATION_CALIBRATION',
];
const DEVICE_EUI_EXEMPT_COMMANDS = [
    ...JOURNAL_COMMANDS,
    ...SCOPED_ACCESS_COMMANDS,
    ...ZONE_COMMANDS,
    ...IRRIGATION_CONFIG_COMMANDS,
];
const JOURNAL_EVENT_BINDINGS = {
    JOURNAL_ENTRY_UPSERTED: ['JOURNAL_ENTRY', 'JournalEntry', 'entry_uuid'],
    JOURNAL_ENTRY_VOIDED: ['JOURNAL_ENTRY', 'JournalEntry', 'entry_uuid'],
    JOURNAL_VOCAB_UPSERTED: ['JOURNAL_VOCAB', 'JournalVocab', 'custom_field_uuid'],
    JOURNAL_PLOT_UPSERTED: ['JOURNAL_PLOT', 'JournalPlot', 'plot_uuid'],
    JOURNAL_PLOT_GROUP_UPSERTED: ['JOURNAL_PLOT_GROUP', 'JournalPlotGroup', 'group_uuid'],
};
const SCOPED_ACCESS_EVENT_OPS = [
    'USER_PLOT_ASSIGNMENT_DELETED',
    'USER_PLOT_ASSIGNMENT_UPSERTED',
    'USER_UPSERTED',
    'USER_ZONE_ASSIGNMENT_DELETED',
    'USER_ZONE_ASSIGNMENT_UPSERTED',
];
const EXPECTED_COMMAND_SEMANTIC_BINDINGS = {
    UPSERT_JOURNAL_ENTRY: {
        effect_key: { prefix: 'journal_entry', uuid_path: 'entry.entry_uuid', version_path: 'entry.base_sync_version' },
    },
    VOID_JOURNAL_ENTRY: {
        effect_key: { prefix: 'journal_entry', uuid_path: 'entry_uuid', version_path: 'base_sync_version' },
    },
    UPSERT_JOURNAL_CUSTOM_VOCAB: {
        effect_key: { prefix: 'journal_vocab', uuid_path: 'custom_vocab.custom_field_uuid', version_path: 'custom_vocab.base_sync_version' },
    },
    UPSERT_JOURNAL_PLOT: {
        effect_key: { prefix: 'journal_plot', uuid_path: 'plot.plot_uuid', version_path: 'plot.base_sync_version' },
    },
    UPSERT_JOURNAL_PLOT_GROUP: {
        effect_key: { prefix: 'journal_plot_group', uuid_path: 'plot_group.group_uuid', version_path: 'plot_group.base_sync_version' },
    },
    UPSERT_SCOPED_USER: {
        effect_key: { prefix: 'scoped_user', uuid_path: 'user.user_uuid', version_path: 'user.base_sync_version' },
    },
    RESET_SCOPED_USER_PASSWORD: {
        effect_key: { prefix: 'scoped_user_password', uuid_path: 'user_uuid', version_path: 'base_sync_version' },
    },
    UPSERT_USER_ZONE_ASSIGNMENT: {
        effect_key: { prefix: 'scoped_zone_assignment', uuid_path: 'zone_assignment.assignment_uuid', version_path: 'zone_assignment.base_sync_version' },
    },
    DELETE_USER_ZONE_ASSIGNMENT: {
        effect_key: { prefix: 'scoped_zone_assignment', uuid_path: 'assignment_uuid', version_path: 'base_sync_version' },
    },
    UPSERT_USER_PLOT_ASSIGNMENT: {
        effect_key: { prefix: 'scoped_plot_assignment', uuid_path: 'plot_assignment.assignment_uuid', version_path: 'plot_assignment.base_sync_version' },
    },
    DELETE_USER_PLOT_ASSIGNMENT: {
        effect_key: { prefix: 'scoped_plot_assignment', uuid_path: 'assignment_uuid', version_path: 'base_sync_version' },
    },
    UPSERT_ZONE: {
        effect_key: { prefix: 'zone', uuid_path: 'zone_uuid', version_path: 'base_sync_version' },
    },
    UPSERT_ZONE_CONFIG: {
        effect_key: { prefix: 'zone', uuid_path: 'zone_uuid', version_path: 'base_sync_version' },
    },
    UPSERT_ZONE_LOCATION: {
        effect_key: { prefix: 'zone', uuid_path: 'zone_uuid', version_path: 'base_sync_version' },
    },
    DELETE_ZONE: {
        effect_key: { prefix: 'zone_delete', uuid_path: 'zone_uuid', version_path: 'base_sync_version' },
    },
    UPSERT_SCHEDULE: {
        effect_key: { prefix: 'schedule', uuid_path: 'zone_uuid', version_path: 'base_sync_version' },
    },
    UPSERT_ZONE_IRRIGATION_CALIBRATION: {
        effect_key: { prefix: 'irrigation_calibration', uuid_path: 'zone_uuid', version_path: 'base_sync_version' },
    },
};
const EXPECTED_EVENT_SEMANTIC_BINDINGS = {
    ...Object.fromEntries(Object.entries(JOURNAL_EVENT_BINDINGS).map(([op, binding]) => [op, {
        aggregate_key_path: `payload.${binding[2]}`,
        sync_version_path: 'payload.sync_version',
    }])),
    USER_UPSERTED: {
        aggregate_key_path: 'payload.user_uuid',
        sync_version_path: 'payload.sync_version',
    },
    USER_ZONE_ASSIGNMENT_UPSERTED: {
        aggregate_key_path: 'payload.assignment_uuid',
        sync_version_path: 'payload.sync_version',
    },
    USER_ZONE_ASSIGNMENT_DELETED: {
        aggregate_key_path: 'payload.assignment_uuid',
        sync_version_path: 'payload.sync_version',
    },
    USER_PLOT_ASSIGNMENT_UPSERTED: {
        aggregate_key_path: 'payload.assignment_uuid',
        sync_version_path: 'payload.sync_version',
    },
    USER_PLOT_ASSIGNMENT_DELETED: {
        aggregate_key_path: 'payload.assignment_uuid',
        sync_version_path: 'payload.sync_version',
    },
    ZONE_IRRIGATION_CALIBRATION_UPSERTED: {
        aggregate_key_path: 'payload.zone_uuid',
        sync_version_path: 'payload.sync_version',
    },
};

function loadSchema(name) {
    return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
    '$schema', '$id', '$ref', 'title', 'description', 'definitions',
    'type', 'const', 'enum', 'properties', 'required', 'additionalProperties',
    'propertyNames', 'items', 'minItems', 'maxItems', 'uniqueItems',
    'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum',
    'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
]);
const SUPPORTED_FORMATS = new Set(['date-time']);
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonValuesEqual(left, right) {
    if (typeof left === 'number' && typeof right === 'number' &&
        Number.isFinite(left) && Number.isFinite(right)) {
        return left === right;
    }
    if (isDeepStrictEqual(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length &&
            left.every((item, index) => jsonValuesEqual(item, right[index]));
    }
    if (isPlainObject(left) && isPlainObject(right)) {
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        return leftKeys.length === rightKeys.length &&
            leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) &&
                jsonValuesEqual(left[key], right[key]));
    }
    return false;
}

function daysInMonth(year, month) {
    if (month === 2) {
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        return leap ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidDateTime(value) {
    const match = DATE_TIME.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offsetHour = match[10] == null ? 0 : Number(match[10]);
    const offsetMinute = match[11] == null ? 0 : Number(match[11]);
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) &&
        hour <= 23 && minute <= 59 && second <= 59 &&
        offsetHour <= 23 && offsetMinute <= 59;
}

function unsupportedKeywordErrors(schema, location) {
    if (!isPlainObject(schema)) return [];
    return Object.keys(schema)
        .filter((keyword) => !SUPPORTED_SCHEMA_KEYWORDS.has(keyword) && !keyword.startsWith('x-'))
        .map((keyword) => `${location}: unsupported schema keyword ${keyword}`);
}

function schemaStructureErrors(schema, rootSchema, location) {
    const at = location || '$';
    const root = rootSchema || schema;
    if (typeof schema === 'boolean') return [];
    if (!isPlainObject(schema)) return [`${at}: schema must be an object or boolean`];
    const errors = unsupportedKeywordErrors(schema, at);
    for (const stringKeyword of ['$schema', '$id', 'title', 'description']) {
        if (schema[stringKeyword] !== undefined && typeof schema[stringKeyword] !== 'string') {
            errors.push(`${at}.${stringKeyword}: must be a string`);
        }
    }
    if (schema.$ref !== undefined) {
        if (typeof schema.$ref !== 'string') {
            errors.push(`${at}.$ref: must be a string`);
        } else {
            try { resolveRef(schema.$ref, root); } catch (error) { errors.push(`${at}.$ref: ${error.message}`); }
        }
    }
    if (schema.pattern !== undefined) {
        if (typeof schema.pattern !== 'string') {
            errors.push(`${at}.pattern: must be a string`);
        } else {
            try { new RegExp(schema.pattern); } catch (error) { errors.push(`${at}.pattern: invalid regex: ${error.message}`); }
        }
    }
    if (schema.format !== undefined) {
        if (typeof schema.format !== 'string') {
            errors.push(`${at}.format: must be a string`);
        } else if (!SUPPORTED_FORMATS.has(schema.format)) {
            errors.push(`${at}.format: unsupported format ${schema.format}`);
        }
    }
    if (schema.required !== undefined) {
        if (!Array.isArray(schema.required) || schema.required.length === 0 ||
            schema.required.some((item) => typeof item !== 'string')) {
            errors.push(`${at}.required: must be a nonempty array of strings`);
        } else if (new Set(schema.required).size !== schema.required.length) {
            errors.push(`${at}.required: must not contain duplicates`);
        }
    }
    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        const allowedTypes = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
        if (types.length === 0 || types.some((type) => !allowedTypes.has(type))) {
            errors.push(`${at}.type: contains an unsupported JSON Schema type`);
        } else if (new Set(types).size !== types.length) {
            errors.push(`${at}.type: must not contain duplicates`);
        }
    }
    if (schema.enum !== undefined) {
        if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
            errors.push(`${at}.enum: must be a nonempty array`);
        } else if (schema.enum.some((candidate, index) =>
            schema.enum.slice(0, index).some((earlier) => jsonValuesEqual(earlier, candidate)))) {
            errors.push(`${at}.enum: must not contain duplicates`);
        }
    }
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') {
        errors.push(`${at}.uniqueItems: must be a boolean`);
    }
    for (const lengthKeyword of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
        if (schema[lengthKeyword] !== undefined &&
            (!Number.isInteger(schema[lengthKeyword]) || schema[lengthKeyword] < 0)) {
            errors.push(`${at}.${lengthKeyword}: must be a non-negative integer`);
        }
    }
    for (const numericKeyword of ['minimum', 'maximum']) {
        if (schema[numericKeyword] !== undefined &&
            (typeof schema[numericKeyword] !== 'number' || !Number.isFinite(schema[numericKeyword]))) {
            errors.push(`${at}.${numericKeyword}: must be a finite number`);
        }
    }
    for (const mapKeyword of ['properties', 'definitions']) {
        if (schema[mapKeyword] === undefined) continue;
        if (!isPlainObject(schema[mapKeyword])) {
            errors.push(`${at}.${mapKeyword}: must be an object`);
            continue;
        }
        for (const [name, child] of Object.entries(schema[mapKeyword])) {
            errors.push(...schemaStructureErrors(child, root, `${at}.${mapKeyword}.${name}`));
        }
    }
    for (const childKeyword of ['items', 'propertyNames', 'not', 'if', 'then', 'else']) {
        if (schema[childKeyword] !== undefined) {
            errors.push(...schemaStructureErrors(schema[childKeyword], root, `${at}.${childKeyword}`));
        }
    }
    if (isPlainObject(schema.additionalProperties)) {
        errors.push(...schemaStructureErrors(schema.additionalProperties, root, `${at}.additionalProperties`));
    } else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
        errors.push(`${at}.additionalProperties: must be a boolean or schema`);
    }
    for (const arrayKeyword of ['allOf', 'anyOf', 'oneOf']) {
        if (schema[arrayKeyword] === undefined) continue;
        if (!Array.isArray(schema[arrayKeyword]) || schema[arrayKeyword].length === 0) {
            errors.push(`${at}.${arrayKeyword}: must be a nonempty array of schemas`);
            continue;
        }
        schema[arrayKeyword].forEach((child, index) => {
            errors.push(...schemaStructureErrors(child, root, `${at}.${arrayKeyword}[${index}]`));
        });
    }
    return errors;
}

function valueHasType(value, type) {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
}

function resolveRef(ref, rootSchema) {
    const parts = ref.split('#');
    const external = parts[0];
    const targetRoot = external ? loadSchema(external) : rootSchema;
    const pointer = parts[1] || '';
    if (pointer === '') return { schema: targetRoot, rootSchema: targetRoot };
    if (!pointer.startsWith('/')) throw new Error(`Unresolved schema reference ${ref}`);
    const rawParts = pointer.slice(1).split('/');
    let target = targetRoot;
    for (const rawPart of rawParts) {
        if (target === null || typeof target !== 'object') {
            throw new Error(`Unresolved schema reference ${ref}`);
        }
        const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!Object.prototype.hasOwnProperty.call(target, part)) {
            throw new Error(`Unresolved schema reference ${ref}`);
        }
        target = target[part];
    }
    return { schema: target, rootSchema: targetRoot };
}

function validationErrors(schema, value, rootSchema, location) {
    const errors = [];
    const root = rootSchema || schema;
    const at = location || '$';
    if (schema === true) return errors;
    if (schema === false) return [`${at}: boolean schema rejects every value`];
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${at}: schema is missing`];
    errors.push(...unsupportedKeywordErrors(schema, at));
    if (schema.$ref !== undefined) {
        try {
            const resolved = resolveRef(schema.$ref, root);
            return errors.concat(validationErrors(resolved.schema, value, resolved.rootSchema, at));
        } catch (error) {
            return errors.concat(`${at}: ${error.message}`);
        }
    }
    if (Array.isArray(schema.allOf)) {
        for (const part of schema.allOf) errors.push(...validationErrors(part, value, root, at));
    }
    if (Array.isArray(schema.anyOf)) {
        const matches = schema.anyOf.filter((part) => validationErrors(part, value, root, at).length === 0);
        if (matches.length === 0) errors.push(`${at}: must match at least one anyOf branch`);
    }
    if (Array.isArray(schema.oneOf)) {
        const matches = schema.oneOf.filter((part) => validationErrors(part, value, root, at).length === 0);
        if (matches.length !== 1) errors.push(`${at}: must match exactly one oneOf branch; matched ${matches.length}`);
    }
    if (schema.if !== undefined) {
        const conditionMatches = validationErrors(schema.if, value, root, at).length === 0;
        const branch = conditionMatches ? schema.then : schema.else;
        if (branch !== undefined) errors.push(...validationErrors(branch, value, root, at));
    }
    if (schema.not !== undefined && validationErrors(schema.not, value, root, at).length === 0) {
        errors.push(`${at}: matches forbidden schema`);
    }
    if (Object.prototype.hasOwnProperty.call(schema, 'const') && !jsonValuesEqual(value, schema.const)) {
        errors.push(`${at}: expected constant ${JSON.stringify(schema.const)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonValuesEqual(candidate, value))) {
        errors.push(`${at}: value is not in enum`);
    }
    if (schema.type) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.some((type) => valueHasType(value, type))) {
            errors.push(`${at}: expected type ${types.join('|')}`);
            return errors;
        }
    }
    if (typeof value === 'string') {
        const codePointLength = Array.from(value).length;
        if (schema.minLength !== undefined && codePointLength < schema.minLength) {
            errors.push(`${at}: string is shorter than ${schema.minLength}`);
        }
        if (schema.maxLength !== undefined && codePointLength > schema.maxLength) {
            errors.push(`${at}: string is longer than ${schema.maxLength}`);
        }
        if (schema.pattern) {
            try {
                if (!(new RegExp(schema.pattern)).test(value)) {
                    errors.push(`${at}: string does not match ${schema.pattern}`);
                }
            } catch (error) {
                errors.push(`${at}: invalid schema pattern ${schema.pattern}: ${error.message}`);
            }
        }
        if (schema.format === 'date-time' && !isValidDateTime(value)) {
            errors.push(`${at}: string does not match format date-time`);
        } else if (schema.format && !SUPPORTED_FORMATS.has(schema.format)) {
            errors.push(`${at}: unsupported schema format ${schema.format}`);
        }
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum`);
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum`);
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: too few items`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: too many items`);
        if (schema.uniqueItems && value.some((item, index) =>
            value.slice(0, index).some((earlier) => jsonValuesEqual(earlier, item)))) {
            errors.push(`${at}: duplicate items`);
        }
        if (schema.items !== undefined) {
            value.forEach((item, index) => errors.push(...validationErrors(schema.items, item, root, `${at}[${index}]`)));
        }
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const properties = schema.properties || {};
        for (const required of schema.required || []) {
            if (!Object.prototype.hasOwnProperty.call(value, required)) errors.push(`${at}.${required}: is required`);
        }
        for (const [key, propertyValue] of Object.entries(value)) {
            if (Object.prototype.hasOwnProperty.call(properties, key)) {
                errors.push(...validationErrors(properties[key], propertyValue, root, `${at}.${key}`));
            } else if (schema.additionalProperties === false) {
                errors.push(`${at}.${key}: additional property is forbidden`);
            } else if (isPlainObject(schema.additionalProperties) || typeof schema.additionalProperties === 'boolean') {
                if (isPlainObject(schema.additionalProperties)) {
                    errors.push(...validationErrors(schema.additionalProperties, propertyValue, root, `${at}.${key}`));
                }
            }
            if (schema.propertyNames !== undefined) {
                errors.push(...validationErrors(schema.propertyNames, key, root, `${at}{${key}}`));
            }
        }
    }
    return errors;
}

function valueAtPath(value, dottedPath) {
    return String(dottedPath || '').split('.').filter(Boolean).reduce((current, part) =>
        current == null ? undefined : current[part], value);
}

function jsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function setValueAtPath(value, dottedPath, replacement) {
    const parts = dottedPath.split('.');
    const leaf = parts.pop();
    const parent = parts.reduce((current, part) => current[part], value);
    parent[leaf] = replacement;
}

function semanticBindingErrors(schema, value) {
    const errors = [];
    const bindings = schema && schema['x-semantic-bindings'];
    const discriminator = value && (value.command_type || value.op);
    const binding = bindings && bindings[discriminator];
    if (!binding) return errors;
    if (IRRIGATION_CONFIG_COMMANDS.includes(discriminator) &&
        !['effect_key', 'base_sync_version', 'target_sync_version', 'schedule',
            'irrigation_calibration'].some((key) =>
            Object.prototype.hasOwnProperty.call(value, key))) {
        return errors;
    }
    if (binding.effect_key) {
        const uuid = valueAtPath(value, binding.effect_key.uuid_path);
        const version = valueAtPath(value, binding.effect_key.version_path);
        const expected = `${binding.effect_key.prefix}:${uuid}:${version}`;
        if (value.effect_key !== expected) {
            errors.push(`$.effect_key: must equal ${expected}`);
        }
        if (IRRIGATION_CONFIG_COMMANDS.includes(discriminator)) {
            const target = value.target_sync_version;
            const resource = discriminator === 'UPSERT_SCHEDULE'
                ? value.schedule
                : value.irrigation_calibration;
            if (target !== version + 1) {
                errors.push('$.target_sync_version: must equal base_sync_version + 1');
            }
            if (resource && resource.zone_uuid !== uuid) {
                errors.push('$.zone_uuid: must equal desired-state zone_uuid');
            }
            if (resource && resource.gateway_device_eui !== value.gateway_device_eui) {
                errors.push('$.gateway_device_eui: must equal desired-state gateway_device_eui');
            }
            if (resource && resource.sync_version !== target) {
                errors.push('$.target_sync_version: must equal desired-state sync_version');
            }
        }
    }
    if (binding.aggregate_key_path) {
        const expected = valueAtPath(value, binding.aggregate_key_path);
        if (value.aggregateKey !== expected) {
            errors.push(`$.aggregateKey: must equal ${binding.aggregate_key_path}`);
        }
    }
    if (binding.sync_version_path) {
        const expected = valueAtPath(value, binding.sync_version_path);
        if (value.syncVersion !== expected) {
            errors.push(`$.syncVersion: must equal ${binding.sync_version_path}`);
        }
    }
    return errors;
}

function contractValidationErrors(schema, value, rootSchema) {
    return validationErrors(schema, value, rootSchema).concat(semanticBindingErrors(schema, value));
}

function reportCheck(condition, success, failure) {
    if (condition) {
        console.log(`OK  ${success}`);
    } else {
        console.error(`FAIL ${failure}`);
        ok = false;
    }
}

function expectValid(label, schema, value, rootSchema) {
    const errors = contractValidationErrors(schema, value, rootSchema);
    reportCheck(errors.length === 0, `${label} validates`, `${label} rejected: ${errors.join('; ')}`);
}

function expectInvalid(label, schema, value, expectedError, rootSchema) {
    const errors = contractValidationErrors(schema, value, rootSchema);
    const matches = errors.length > 0 && (!expectedError || errors.some((error) => expectedError.test(error)));
    reportCheck(matches, `${label} is rejected`, `${label} unexpectedly validated or missed ${expectedError}: ${errors.join('; ')}`);
}

let ok = true;

expectInvalid(
    'schema evaluator rejects an unsupported post-Draft-07 keyword',
    { type: 'object', unevaluatedProperties: false },
    {},
    /unsupported.*unevaluatedProperties/
);
expectInvalid(
    'schema evaluator applies anyOf',
    { anyOf: [{ const: 'left' }, { const: 'right' }] },
    'neither',
    /anyOf/
);
expectInvalid(
    'schema evaluator applies oneOf exactly once',
    { oneOf: [{ const: 'same' }, { type: 'string' }] },
    'same',
    /oneOf/
);
expectInvalid(
    'schema evaluator checks real date-time calendar values',
    { type: 'string', format: 'date-time' },
    '2026-02-30T10:00:00.000Z',
    /format.*date-time/
);
expectValid(
    'schema evaluator counts one supplementary Unicode code point as length one',
    { type: 'string', maxLength: 1 },
    '😀'
);
expectInvalid(
    'schema evaluator counts one supplementary Unicode code point below minLength two',
    { type: 'string', minLength: 2 },
    '😀',
    /shorter/
);
expectValid(
    'schema evaluator applies object-valued const by JSON deep equality',
    { const: { nested: { value: 1 } } },
    { nested: { value: 1 } }
);
expectValid(
    'schema evaluator applies object-valued enum by JSON deep equality',
    { enum: [{ nested: ['value'] }] },
    { nested: ['value'] }
);
expectInvalid(
    'schema evaluator applies uniqueItems by JSON deep equality',
    { type: 'array', uniqueItems: true },
    [{ first: 1, second: 2 }, { second: 2, first: 1 }],
    /duplicate/
);
expectValid(
    'schema evaluator treats negative zero and zero as equal for const',
    { const: { nested: -0 } },
    { nested: 0 }
);
expectValid(
    'schema evaluator treats negative zero and zero as equal for enum',
    { enum: [{ nested: -0 }] },
    { nested: 0 }
);
expectInvalid(
    'schema evaluator treats negative zero and zero as duplicates for uniqueItems',
    { type: 'array', uniqueItems: true },
    [{ nested: -0 }, { nested: 0 }],
    /duplicate/
);
expectInvalid(
    'schema evaluator follows a reference to a false schema',
    { $ref: '#/definitions/Never', definitions: { Never: false } },
    'value',
    /boolean schema rejects/
);
expectInvalid(
    'schema evaluator rejects a child reference beneath a false schema',
    { $ref: '#/definitions/Never/child', definitions: { Never: false } },
    'value',
    /Unresolved schema reference/
);
expectInvalid(
    'schema evaluator preserves an empty JSON Pointer token',
    { $ref: '#/definitions/', definitions: { '': { const: 'allowed' } } },
    'denied',
    /constant/
);
expectInvalid(
    'schema evaluator decodes escaped JSON Pointer tokens',
    { $ref: '#/definitions/slash~1tilde~0key', definitions: { 'slash/tilde~key': { const: 'allowed' } } },
    'denied',
    /constant/
);
expectInvalid(
    'schema evaluator applies else when if is false',
    { if: false, then: true, else: { const: 'allowed' } },
    'denied',
    /constant/
);
expectInvalid(
    'schema evaluator applies a false then schema',
    { if: true, then: false },
    'value',
    /boolean schema rejects/
);
expectInvalid(
    'schema evaluator applies a false else schema',
    { if: { const: 'match' }, else: false },
    'other',
    /boolean schema rejects/
);
expectInvalid(
    'schema evaluator applies a false items schema',
    { type: 'array', items: false },
    ['value'],
    /boolean schema rejects/
);
expectInvalid(
    'schema evaluator applies a false propertyNames schema',
    { type: 'object', propertyNames: false },
    { property: 'value' },
    /boolean schema rejects/
);
expectInvalid(
    'schema evaluator applies a false property schema',
    { type: 'object', properties: { property: false } },
    { property: 'value' },
    /boolean schema rejects/
);
for (const [label, malformedSchema, expectedError] of [
    ['unresolved references', { $ref: '#/definitions/Missing', definitions: {} }, /Unresolved schema reference/],
    ['invalid regular expressions', { type: 'string', pattern: '[' }, /invalid regex/],
    ['malformed properties maps', { type: 'object', properties: [] }, /properties.*object/],
    ['empty oneOf arrays', { oneOf: [] }, /oneOf.*nonempty/],
    ['unsupported formats', { type: 'string', format: 'journal-time' }, /unsupported format/],
    ['negative minLength', { type: 'string', minLength: -1 }, /minLength.*non-negative integer/],
    ['fractional maxLength', { type: 'string', maxLength: 1.5 }, /maxLength.*non-negative integer/],
    ['negative minItems', { type: 'array', minItems: -1 }, /minItems.*non-negative integer/],
    ['fractional maxItems', { type: 'array', maxItems: 1.5 }, /maxItems.*non-negative integer/],
    ['non-array enum', { enum: 'one' }, /enum.*nonempty array/],
    ['empty enum', { enum: [] }, /enum.*nonempty array/],
    ['duplicate enum numbers', { enum: [{ nested: -0 }, { nested: 0 }] }, /enum.*duplicates/],
    ['non-boolean uniqueItems', { type: 'array', uniqueItems: 'true' }, /uniqueItems.*boolean/],
    ['duplicate type arrays', { type: ['string', 'string'] }, /type.*duplicates/],
    ['empty required arrays', { type: 'object', required: [] }, /required.*nonempty array/],
    ['non-numeric minimum', { type: 'number', minimum: '0' }, /minimum.*finite number/],
    ['non-numeric maximum', { type: 'number', maximum: null }, /maximum.*finite number/],
]) {
    const errors = schemaStructureErrors(malformedSchema);
    reportCheck(
        errors.some((error) => expectedError.test(error)),
        `schema evaluator fails closed on ${label}`,
        `schema evaluator missed ${label}: ${errors.join('; ')}`
    );
}
for (const [label, supportedSchema] of [
    ['string keyword shapes', { type: ['string', 'null'], minLength: 0, maxLength: 3, pattern: '^.*$' }],
    ['numeric keyword shapes', { type: 'number', minimum: 0, maximum: 1 }],
    ['array keyword shapes', { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 2, uniqueItems: true }],
    ['object keyword shapes', {
        type: 'object',
        properties: { name: { type: 'string' } },
        propertyNames: { type: 'string' },
        required: ['name'],
        additionalProperties: false,
    }],
    ['conditional and composition keyword shapes', {
        allOf: [true],
        anyOf: [{ const: 'left' }],
        oneOf: [{ enum: ['left'] }],
        not: false,
        if: { type: 'string' },
        then: true,
        else: false,
    }],
]) {
    const errors = schemaStructureErrors(supportedSchema);
    reportCheck(
        errors.length === 0,
        `schema evaluator accepts ${label}`,
        `schema evaluator rejected ${label}: ${errors.join('; ')}`
    );
}

// L5: events.schema.json syncVersion minimum must be 0
const eventsSchema = loadSchema('events.schema.json');
const svMin = eventsSchema.properties && eventsSchema.properties.syncVersion && eventsSchema.properties.syncVersion.minimum;
if (svMin !== 0) {
    console.error(`FAIL L5: events.schema.json syncVersion minimum is ${svMin}, expected 0`);
    ok = false;
} else {
    console.log('OK  L5: syncVersion minimum is 0');
}

const eventPayload = eventsSchema.properties && eventsSchema.properties.payload;
const eventPayloadContractVersion = eventPayload && eventPayload.properties && eventPayload.properties.contract_version;
if (!eventPayload || !Array.isArray(eventPayload.required) || !eventPayload.required.includes('contract_version')) {
    console.error('FAIL schema: event payload does not require contract_version');
    ok = false;
} else if (!eventPayloadContractVersion || eventPayloadContractVersion.type !== 'integer' || eventPayloadContractVersion.const !== 1) {
    console.error('FAIL schema: event payload contract_version is not integer const 1');
    ok = false;
} else {
    console.log('OK  schema: event payload requires contract_version const 1');
}

const sampleEvent = {
    eventUuid: 'event-fixture-1',
    aggregateType: 'DEVICE_DATA',
    aggregateKey: 'device-fixture-1',
    op: 'DEVICE_DATA_APPENDED',
    syncVersion: 1,
    occurredAt: '2026-07-05T00:00:00.000Z',
    payload: {
        contract_version: 1,
        device_eui: 'DEVICE_FIXTURE_1'
    }
};
const eventRequired = eventsSchema.required || [];
const eventProps = eventsSchema.properties || {};
const sampleMissing = eventRequired.filter((property) => !(property in sampleEvent));
const sampleExtras = Object.keys(sampleEvent).filter((property) => !eventProps[property]);
if (sampleMissing.length || (eventsSchema.additionalProperties === false && sampleExtras.length)) {
    console.error(`FAIL schema: real V2 event sample does not match required envelope; missing=${sampleMissing.join(',') || '(none)'} extra=${sampleExtras.join(',') || '(none)'}`);
    ok = false;
} else if (!eventsSchema.properties.op.enum.includes(sampleEvent.op)) {
    console.error(`FAIL schema: real V2 event sample op ${sampleEvent.op} is not in event op enum`);
    ok = false;
} else if (sampleEvent.payload.contract_version !== eventPayloadContractVersion.const) {
    console.error('FAIL schema: real V2 event sample payload contract_version does not match schema const');
    ok = false;
} else {
    console.log('OK  schema: real V2 event sample matches event envelope');
}
const nonJournalWithoutOccurredAt = Object.assign({}, sampleEvent);
delete nonJournalWithoutOccurredAt.occurredAt;
expectValid('non-journal event remains compatible without occurredAt', eventsSchema, nonJournalWithoutOccurredAt);
expectValid(
    'non-journal event remains compatible with null occurredAt',
    eventsSchema,
    Object.assign({}, sampleEvent, { occurredAt: null })
);

const sampleWorkRequestEvent = {
    eventUuid: 'req-0016C001F11715E2-20260708T120000Z',
    aggregateType: 'WORK_REQUEST',
    aggregateKey: '019ff001-1111-7222-8333-aaaaaaaaaaaa',
    op: 'WORK_REQUEST_SUBMITTED',
    syncVersion: 1,
    occurredAt: '2026-07-08T12:00:00.000Z',
    payload: {
        contract_version: 1,
        schema_version: 1,
        request_id: '019ff001-1111-7222-8333-aaaaaaaaaaaa',
        type: 'bug',
        title: 'Pump status is confusing',
        contact_email: 'farmer@example.com',
        description: 'The dashboard says the pump is open after I closed it.',
        area: 'dashboard',
        severity: 'annoying',
        consent_public: true,
        consent_diagnostics: true,
        gateway_device_eui: '0016C001F11715E2',
        status_secret_hash: 'sha256:status-secret-fixture',
        contact_email: 'field-user@example.test',
        diagnostics: { sync: { pending_outbox_count: 0 } },
        gui_user: { local_user_id: 7, username: 'field-user' }
    }
};
const workRequestSampleMissing = eventRequired.filter((property) => !(property in sampleWorkRequestEvent));
const workRequestSampleExtras = Object.keys(sampleWorkRequestEvent).filter((property) => !eventProps[property]);
if (workRequestSampleMissing.length || (eventsSchema.additionalProperties === false && workRequestSampleExtras.length)) {
    console.error(`FAIL schema: WORK_REQUEST_SUBMITTED sample does not match required envelope; missing=${workRequestSampleMissing.join(',') || '(none)'} extra=${workRequestSampleExtras.join(',') || '(none)'}`);
    ok = false;
} else if (!eventsSchema.properties.op.enum.includes(sampleWorkRequestEvent.op)) {
    console.error(`FAIL schema: WORK_REQUEST_SUBMITTED sample op ${sampleWorkRequestEvent.op} is not in event op enum`);
    ok = false;
} else if (sampleWorkRequestEvent.payload.contract_version !== eventPayloadContractVersion.const) {
    console.error('FAIL schema: WORK_REQUEST_SUBMITTED sample payload contract_version does not match schema const');
    ok = false;
} else {
    console.log('OK  schema: WORK_REQUEST_SUBMITTED sample matches event envelope');
}

// M7: commands.schema.json SET_STREGA_TIMED_ACTION must not require duration_seconds
const cmdSchema = loadSchema('commands.schema.json');
const commandIdPattern = new RegExp(cmdSchema.properties.command_id.pattern);
for (const commandId of [
    'a1234567-b89c-4def-9012-abcdefabcdef',
    'A1234567-B89C-4DEF-9012-ABCDEFABCDEF'
]) {
    if (!commandIdPattern.test(commandId)) {
        console.error(`FAIL schema: command_id pattern rejects valid UUID casing ${commandId}`);
        ok = false;
    } else {
        console.log(`OK  schema: command_id accepts UUID casing ${commandId}`);
    }
}

const allOf = cmdSchema.allOf || [];
const stregaTimedRequiresDurationSeconds = allOf.some(rule =>
    rule.if && rule.if.properties && rule.if.properties.command_type &&
    rule.if.properties.command_type.const === 'SET_STREGA_TIMED_ACTION' &&
    rule.then && rule.then.required && rule.then.required.includes('duration_seconds')
);
if (stregaTimedRequiresDurationSeconds) {
    console.error('FAIL M7: commands.schema.json SET_STREGA_TIMED_ACTION still requires duration_seconds');
    ok = false;
} else {
    console.log('OK  M7: SET_STREGA_TIMED_ACTION does not require duration_seconds');
}

// M7: commands.schema.json must have 'amount' property
const hasAmount = cmdSchema.properties && cmdSchema.properties.amount;
if (!hasAmount) {
    console.error('FAIL M7: commands.schema.json missing amount property');
    ok = false;
} else {
    console.log('OK  M7: amount property present in commands.schema.json');
}

if (!cmdSchema.properties.command_type.enum.includes('WORK_REQUEST_STATUS')) {
    console.error('FAIL schema: commands.schema.json missing WORK_REQUEST_STATUS command_type');
    ok = false;
} else {
    console.log('OK  schema: WORK_REQUEST_STATUS command_type present');
}

const workRequestStatusRule = allOf.find(rule =>
    rule.if && rule.if.properties && rule.if.properties.command_type &&
    rule.if.properties.command_type.const === 'WORK_REQUEST_STATUS'
);
const workRequestStatusRequired = workRequestStatusRule &&
    workRequestStatusRule.then &&
    workRequestStatusRule.then.required || [];
const workRequestStatusRequestIdType = workRequestStatusRule &&
    workRequestStatusRule.then &&
    workRequestStatusRule.then.properties &&
    workRequestStatusRule.then.properties.request_id &&
    workRequestStatusRule.then.properties.request_id.type;
const workRequestStatusRequestIdMinLength = workRequestStatusRule &&
    workRequestStatusRule.then &&
    workRequestStatusRule.then.properties &&
    workRequestStatusRule.then.properties.request_id &&
    workRequestStatusRule.then.properties.request_id.minLength;
const workRequestStatusStatusType = workRequestStatusRule &&
    workRequestStatusRule.then &&
    workRequestStatusRule.then.properties &&
    workRequestStatusRule.then.properties.status &&
    workRequestStatusRule.then.properties.status.type;
const workRequestStatusStatusMinLength = workRequestStatusRule &&
    workRequestStatusRule.then &&
    workRequestStatusRule.then.properties &&
    workRequestStatusRule.then.properties.status &&
    workRequestStatusRule.then.properties.status.minLength;
if (!workRequestStatusRequired.includes('request_id') || !workRequestStatusRequired.includes('status')) {
    console.error('FAIL schema: WORK_REQUEST_STATUS does not require request_id and status');
    ok = false;
} else if (workRequestStatusRequestIdType !== 'string' || workRequestStatusStatusType !== 'string') {
    console.error('FAIL schema: WORK_REQUEST_STATUS request_id/status can still be null');
    ok = false;
} else if (workRequestStatusRequestIdMinLength !== 1 || workRequestStatusStatusMinLength !== 1) {
    console.error('FAIL schema: WORK_REQUEST_STATUS request_id/status do not require minLength 1');
    ok = false;
} else {
    console.log('OK  schema: WORK_REQUEST_STATUS requires non-empty request_id and status');
}

const openForDurationRule = allOf.find(rule =>
    rule.if && rule.if.properties && rule.if.properties.command_type &&
    rule.if.properties.command_type.const === 'OPEN_FOR_DURATION'
);
const openDurationType = openForDurationRule &&
    openForDurationRule.then &&
    openForDurationRule.then.properties &&
    openForDurationRule.then.properties.duration_seconds &&
    openForDurationRule.then.properties.duration_seconds.type;
if (openDurationType !== 'integer') {
    console.error('FAIL schema: OPEN_FOR_DURATION duration_seconds can still be null');
    ok = false;
} else {
    console.log('OK  schema: OPEN_FOR_DURATION duration_seconds is non-null integer');
}

const stregaTimedRule = allOf.find(rule =>
    rule.if && rule.if.properties && rule.if.properties.command_type &&
    rule.if.properties.command_type.const === 'SET_STREGA_TIMED_ACTION'
);
const timedAmountType = stregaTimedRule &&
    stregaTimedRule.then &&
    stregaTimedRule.then.properties &&
    stregaTimedRule.then.properties.amount &&
    stregaTimedRule.then.properties.amount.type;
if (timedAmountType !== 'integer') {
    console.error('FAIL schema: SET_STREGA_TIMED_ACTION amount can still be null');
    ok = false;
} else {
    console.log('OK  schema: SET_STREGA_TIMED_ACTION amount is non-null integer');
}

const uc512DurationRule = allOf.find(rule =>
    rule.if && rule.if.properties && rule.if.properties.command_type &&
    rule.if.properties.command_type.const === 'UC512_OPEN_FOR_DURATION'
);
const uc512DurationRequired = uc512DurationRule && uc512DurationRule.then &&
    Array.isArray(uc512DurationRule.then.required) &&
    uc512DurationRule.then.required.includes('duration_seconds');
const uc512DurationType = uc512DurationRule && uc512DurationRule.then &&
    uc512DurationRule.then.properties && uc512DurationRule.then.properties.duration_seconds &&
    uc512DurationRule.then.properties.duration_seconds.type;
reportCheck(
    uc512DurationRequired && uc512DurationType === 'integer',
    'schema: UC512_OPEN_FOR_DURATION requires non-null duration_seconds',
    'schema: UC512_OPEN_FOR_DURATION lacks its runtime duration requirement'
);

// Contract resources must match edge runtime device and schedule enums.
const resourcesSchema = loadSchema('resources.schema.json');
for (const [name, schema] of [
    ['commands.schema.json', cmdSchema],
    ['events.schema.json', eventsSchema],
    ['resources.schema.json', resourcesSchema],
]) {
    const errors = schemaStructureErrors(schema);
    reportCheck(
        errors.length === 0,
        `${name} uses only supported, well-formed Draft-07 schema constructs`,
        `${name} schema structure is invalid: ${errors.join('; ')}`
    );
}
const deviceTypes = resourcesSchema.definitions.Device.properties.type_id.enum || [];
for (const type of ['TEKTELIC_CLOVER', 'SENSECAP_S2120']) {
    if (!deviceTypes.includes(type)) {
        console.error(`FAIL schema: resources.schema.json missing device type ${type}`);
        ok = false;
    } else {
        console.log(`OK  schema: device type ${type} present`);
    }
}
for (const type of ['S2120_WEATHER', 'GATEWAY']) {
    if (deviceTypes.includes(type)) {
        console.error(`FAIL schema: resources.schema.json contains non-edge device type ${type}`);
        ok = false;
    } else {
        console.log(`OK  schema: non-edge device type ${type} absent`);
    }
}

const triggerMetrics = resourcesSchema.definitions.Schedule.properties.trigger_metric.enum || [];
const expectedTriggerMetrics = ['SWT_WM1', 'SWT_WM2', 'SWT_AVG', 'SWT_1', 'SWT_2', 'SWT_3', 'DENDRO'];
if (triggerMetrics.join(',') !== expectedTriggerMetrics.join(',')) {
    console.error(`FAIL schema: trigger_metric enum is ${triggerMetrics.join(',')}, expected ${expectedTriggerMetrics.join(',')}`);
    ok = false;
} else {
    console.log('OK  schema: trigger_metric enum matches edge schedule validation');
}

for (const type of ['AQUASCOPE_LORAIN', 'MILESIGHT_UC512']) {
    reportCheck(
        deviceTypes.includes(type),
        `schema: device type ${type} present`,
        `schema: resources.schema.json missing device type ${type}`
    );
}

let staging;
if (!fs.existsSync(STAGING_MANIFEST)) {
    console.error(`FAIL staging manifest missing at ${STAGING_MANIFEST}`);
    ok = false;
} else {
    staging = JSON.parse(fs.readFileSync(STAGING_MANIFEST, 'utf8'));
    const exactStaging = staging && staging.version === 1 &&
        JSON.stringify(staging.commands && staging.commands.edgeDeferred) === JSON.stringify([]) &&
        JSON.stringify(staging.commands && staging.commands.cloudDeferred) === JSON.stringify([]) &&
        JSON.stringify(staging.eventOps && staging.eventOps.edgeModuleOwned) === JSON.stringify([
            'JOURNAL_ENTRY_UPSERTED',
            'JOURNAL_ENTRY_VOIDED',
            'JOURNAL_VOCAB_UPSERTED',
            'JOURNAL_PLOT_UPSERTED',
            'JOURNAL_PLOT_GROUP_UPSERTED',
        ]) &&
        JSON.stringify(staging.eventOps && staging.eventOps.edgeDeferred) === JSON.stringify([]) &&
        JSON.stringify(staging.eventOps && staging.eventOps.cloudDeferred) === JSON.stringify([]);
    reportCheck(
        exactStaging,
        'staging manifest records activated irrigation calibration rollout',
        'staging manifest drifted from the activated irrigation calibration rollout'
    );
}

const scopedUserCommand = {
    command_id: UUID,
    command_type: 'UPSERT_SCOPED_USER',
    effect_key: `scoped_user:${UUID}:0`,
    user: {
        user_uuid: UUID,
        username: 'researcher-one',
        role: 'researcher',
        disabled_at: null,
        sync_version: 1,
        base_sync_version: 0,
        gateway_device_eui: '0123456789ABCDEF',
    },
};
expectValid('UPSERT_SCOPED_USER canonical command', cmdSchema, scopedUserCommand, cmdSchema);
expectInvalid(
    'UPSERT_SCOPED_USER rejects plaintext password',
    cmdSchema,
    { ...scopedUserCommand, user: { ...scopedUserCommand.user, password: 'secret' } },
    /password.*enum|property/
);
expectInvalid(
    'UPSERT_SCOPED_USER rejects mismatched effect identity',
    cmdSchema,
    { ...scopedUserCommand, effect_key: `scoped_user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:0` },
    /effect_key.*(?:equal|match)/
);
const bcryptHash = '$2b$10$' + 'a'.repeat(53);
expectValid(
    'RESET_SCOPED_USER_PASSWORD accepts bcrypt hash without plaintext',
    cmdSchema,
    {
        command_id: UUID,
        command_type: 'RESET_SCOPED_USER_PASSWORD',
        effect_key: `scoped_user_password:${UUID}:1`,
        user_uuid: UUID,
        base_sync_version: 1,
        password_hash: bcryptHash,
    },
    cmdSchema
);
expectInvalid(
    'DELETE_USER_ZONE_ASSIGNMENT requires a base version',
    cmdSchema,
    {
        command_id: UUID,
        command_type: 'DELETE_USER_ZONE_ASSIGNMENT',
        effect_key: `scoped_zone_assignment:${UUID}:0`,
        assignment_uuid: UUID,
    },
    /base_sync_version.*required/
);
expectValid(
    'UPSERT_USER_PLOT_ASSIGNMENT canonical command',
    cmdSchema,
    {
        command_id: UUID,
        command_type: 'UPSERT_USER_PLOT_ASSIGNMENT',
        effect_key: `scoped_plot_assignment:${UUID}:0`,
        plot_assignment: {
            assignment_uuid: UUID,
            user_uuid: UUID,
            plot_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            assigned_by_user_uuid: null,
            sync_version: 1,
            base_sync_version: 0,
            deleted_at: null,
            gateway_device_eui: '0123456789ABCDEF',
        },
    },
    cmdSchema
);

const zoneDesiredState = {
    contract_version: 1,
    zone_uuid: UUID,
    name: 'North block',
    gateway_device_eui: '0123456789ABCDEF',
    timezone: 'Europe/Zurich',
    latitude: 47.3769,
    longitude: 8.5417,
    phenological_stage: 'flowering',
    calibration_key: 'pear-v1',
    crop_type: 'pear',
    variety: 'conference',
    soil_type: 'loam',
    irrigation_method: 'drip',
    area_m2: 1500,
    irrigation_efficiency_pct: 87.5,
    scheduling_mode: 'server_preferred',
    prediction_card_enabled: 1,
    notes: 'north block',
    sync_version: 1,
    deleted_at: null,
    user: {
        user_uuid: UUID,
        cloudUserId: 41,
    },
};
const zoneUpsertCommand = {
    command_id: UUID,
    command_type: 'UPSERT_ZONE',
    effect_key: `zone:${UUID}:0`,
    zone_uuid: UUID,
    gateway_device_eui: '0123456789ABCDEF',
    base_sync_version: 0,
    target_sync_version: 1,
    zone: zoneDesiredState,
};
expectValid(
    'UPSERT_ZONE protected desired-state command',
    cmdSchema,
    zoneUpsertCommand,
    cmdSchema
);
expectValid(
    'UPSERT_ZONE_CONFIG protected full aggregate command',
    cmdSchema,
    {
        ...zoneUpsertCommand,
        command_type: 'UPSERT_ZONE_CONFIG',
    },
    cmdSchema
);
expectValid(
    'UPSERT_ZONE_LOCATION protected full aggregate command',
    cmdSchema,
    {
        ...zoneUpsertCommand,
        command_type: 'UPSERT_ZONE_LOCATION',
    },
    cmdSchema
);
expectValid(
    'DELETE_ZONE protected tombstone command',
    cmdSchema,
    {
        command_id: UUID,
        command_type: 'DELETE_ZONE',
        effect_key: `zone_delete:${UUID}:1`,
        zone_uuid: UUID,
        gateway_device_eui: '0123456789ABCDEF',
        base_sync_version: 1,
        target_sync_version: 2,
        zone: {
            contract_version: 1,
            zone_uuid: UUID,
            gateway_device_eui: '0123456789ABCDEF',
            sync_version: 2,
            deleted_at: '2026-07-24T02:00:00.000Z',
        },
    },
    cmdSchema
);
expectInvalid(
    'UPSERT_ZONE rejects cloud-only weather source',
    cmdSchema,
    {
        ...zoneUpsertCommand,
        zone: {
            ...zoneDesiredState,
            weather_source: 'meteoblue',
        },
    },
    /weather_source.*(?:forbidden|enum|property)/,
    cmdSchema
);
expectInvalid(
    'UPSERT_ZONE rejects a missing target version',
    cmdSchema,
    (({ target_sync_version, ...command }) => command)(zoneUpsertCommand),
    /target_sync_version.*required/,
    cmdSchema
);
expectInvalid(
    'UPSERT_ZONE rejects mismatched effect identity',
    cmdSchema,
    {
        ...zoneUpsertCommand,
        effect_key: `zone:${UUID}:1`,
    },
    /effect_key.*(?:equal|match)/,
    cmdSchema
);

const scheduleDesiredState = {
    contract_version: 1,
    zone_uuid: UUID,
    gateway_device_eui: '0123456789ABCDEF',
    trigger_metric: 'SWT_1',
    threshold_kpa: 35.5,
    enabled: 1,
    duration_minutes: 20,
    response_mode: 'proportional',
    sync_version: 1,
    deleted_at: null,
    last_applied_at: null,
};
const scheduleUpsertCommand = {
    command_id: UUID,
    command_type: 'UPSERT_SCHEDULE',
    effect_key: `schedule:${UUID}:0`,
    zone_uuid: UUID,
    gateway_device_eui: '0123456789ABCDEF',
    base_sync_version: 0,
    target_sync_version: 1,
    schedule: scheduleDesiredState,
};
const calibrationDesiredState = {
    contract_version: 1,
    zone_uuid: UUID,
    gateway_device_eui: '0123456789ABCDEF',
    measured_flow_rate_lpm: 12.5,
    measurement_method: 'Timed bucket test',
    measured_at: '2026-07-24T10:00:00.000Z',
    sync_version: 1,
    deleted_at: null,
    last_applied_at: null,
};
const calibrationUpsertCommand = {
    command_id: UUID,
    command_type: 'UPSERT_ZONE_IRRIGATION_CALIBRATION',
    effect_key: `irrigation_calibration:${UUID}:0`,
    zone_uuid: UUID,
    gateway_device_eui: '0123456789ABCDEF',
    base_sync_version: 0,
    target_sync_version: 1,
    irrigation_calibration: calibrationDesiredState,
};
expectValid(
    'UPSERT_SCHEDULE protected desired-state command',
    cmdSchema,
    scheduleUpsertCommand,
    cmdSchema
);
expectValid(
    'UPSERT_SCHEDULE legacy device command remains accepted',
    cmdSchema,
    {
        command_id: UUID,
        command_type: 'UPSERT_SCHEDULE',
        device_eui: '0123456789ABCDEF',
        zone_id: 12,
        duration_minutes: 20,
    },
    cmdSchema
);
expectValid(
    'UPSERT_ZONE_IRRIGATION_CALIBRATION protected desired-state command',
    cmdSchema,
    calibrationUpsertCommand,
    cmdSchema
);
expectInvalid(
    'UPSERT_SCHEDULE rejects non-consecutive target version',
    cmdSchema,
    { ...scheduleUpsertCommand, target_sync_version: 2 },
    /target_sync_version.*base_sync_version/,
    cmdSchema
);
expectInvalid(
    'UPSERT_SCHEDULE rejects unsupported edge metric',
    cmdSchema,
    {
        ...scheduleUpsertCommand,
        schedule: { ...scheduleDesiredState, trigger_metric: 'VWC' },
    },
    /trigger_metric.*enum/,
    cmdSchema
);
expectInvalid(
    'UPSERT_SCHEDULE rejects wrong desired-state gateway',
    cmdSchema,
    {
        ...scheduleUpsertCommand,
        schedule: {
            ...scheduleDesiredState,
            gateway_device_eui: 'FFFFFFFFFFFFFFFF',
        },
    },
    /gateway_device_eui.*desired-state/,
    cmdSchema
);
expectInvalid(
    'UPSERT_SCHEDULE rejects wrong desired-state UUID',
    cmdSchema,
    {
        ...scheduleUpsertCommand,
        zone_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        effect_key: 'schedule:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:0',
    },
    /zone_uuid.*desired-state/,
    cmdSchema
);
expectInvalid(
    'UPSERT_SCHEDULE rejects non-finite threshold',
    cmdSchema,
    {
        ...scheduleUpsertCommand,
        schedule: { ...scheduleDesiredState, threshold_kpa: Infinity },
    },
    /threshold_kpa.*type number/,
    cmdSchema
);
expectInvalid(
    'UPSERT_SCHEDULE rejects invalid duration',
    cmdSchema,
    {
        ...scheduleUpsertCommand,
        schedule: { ...scheduleDesiredState, duration_minutes: 0 },
    },
    /duration_minutes.*minimum/,
    cmdSchema
);
expectInvalid(
    'UPSERT_SCHEDULE rejects invalid response mode',
    cmdSchema,
    {
        ...scheduleUpsertCommand,
        schedule: { ...scheduleDesiredState, response_mode: 'adaptive' },
    },
    /response_mode.*enum/,
    cmdSchema
);
expectInvalid(
    'UPSERT_SCHEDULE rejects camel-case protected envelope fields',
    cmdSchema,
    {
        command_id: UUID,
        command_type: 'UPSERT_SCHEDULE',
        effectKey: `schedule:${UUID}:0`,
        zone_uuid: UUID,
        gateway_device_eui: '0123456789ABCDEF',
        baseSyncVersion: 0,
        targetSyncVersion: 1,
        schedule: scheduleDesiredState,
    },
    /effectKey.*(?:forbidden|property)/,
    cmdSchema
);
expectInvalid(
    'UPSERT_SCHEDULE rejects unknown desired-state fields',
    cmdSchema,
    {
        ...scheduleUpsertCommand,
        schedule: { ...scheduleDesiredState, last_triggered_at: null },
    },
    /last_triggered_at.*(?:forbidden|property)/,
    cmdSchema
);
expectInvalid(
    'UPSERT_ZONE_IRRIGATION_CALIBRATION rejects non-positive rate',
    cmdSchema,
    {
        ...calibrationUpsertCommand,
        irrigation_calibration: {
            ...calibrationDesiredState,
            measured_flow_rate_lpm: 0,
        },
    },
    /measured_flow_rate_lpm/,
    cmdSchema
);
expectInvalid(
    'UPSERT_ZONE_IRRIGATION_CALIBRATION rejects non-finite rate',
    cmdSchema,
    {
        ...calibrationUpsertCommand,
        irrigation_calibration: {
            ...calibrationDesiredState,
            measured_flow_rate_lpm: NaN,
        },
    },
    /measured_flow_rate_lpm.*type number/,
    cmdSchema
);
expectInvalid(
    'UPSERT_ZONE_IRRIGATION_CALIBRATION rejects non-canonical timestamp',
    cmdSchema,
    {
        ...calibrationUpsertCommand,
        irrigation_calibration: {
            ...calibrationDesiredState,
            measured_at: '2026-07-24T10:00:00Z',
        },
    },
    /measured_at.*match/,
    cmdSchema
);
expectInvalid(
    'UPSERT_ZONE_IRRIGATION_CALIBRATION rejects an unknown field',
    cmdSchema,
    {
        ...calibrationUpsertCommand,
        irrigation_calibration: {
            ...calibrationDesiredState,
            valve_device_eui: '0123456789ABCDEF',
        },
    },
    /valve_device_eui.*(?:forbidden|property)/,
    cmdSchema
);
const calibrationEvent = {
    eventUuid: UUID,
    aggregateType: 'IRRIGATION_CALIBRATION',
    aggregateKey: UUID,
    op: 'ZONE_IRRIGATION_CALIBRATION_UPSERTED',
    syncVersion: 1,
    occurredAt: '2026-07-24T10:01:00.000Z',
    payload: calibrationDesiredState,
};
expectValid(
    'ZONE_IRRIGATION_CALIBRATION_UPSERTED canonical event',
    eventsSchema,
    calibrationEvent,
    eventsSchema
);
expectInvalid(
    'ZONE_IRRIGATION_CALIBRATION_UPSERTED rejects mismatched aggregate key',
    eventsSchema,
    {
        ...calibrationEvent,
        aggregateKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    /aggregateKey.*payload.zone_uuid/,
    eventsSchema
);

const journalEntry = {
    contract_version: 1,
    entry_uuid: UUID,
    base_sync_version: 0,
    owner_user_uuid: COMPACT_UUID,
    author_principal_uuid: COMPACT_UUID,
    author_label: 'Field operator',
    plot_uuid: UUID,
    zone_uuid: UUID,
    device_eui: null,
    season_uuid: null,
    season_crop: null,
    season_variety: null,
    campaign_uuid: null,
    protocol_code: null,
    protocol_version: null,
    observation_unit_code: null,
    pass_uuid: null,
    batch_uuid: UUID,
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    catalog_version: 1,
    occurred_start: '2026-07-13T08:00:00.000Z',
    occurred_end: null,
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    recorded_at: '2026-07-13T08:01:00.000Z',
    origin: 'cloud-ui',
    status: 'final',
    voided_at: null,
    voided_by_principal_uuid: null,
    void_reason: null,
    note: 'Irrigation round',
    context_json: null,
    sync_version: 1,
    gateway_device_eui: '0016C001F11715E2',
    created_at: '2026-07-13T08:01:00.000Z',
    updated_at: '2026-07-13T08:01:00.000Z',
    deleted_at: null,
    values: [{
        attribute_code: 'attr.irrigation_depth',
        group_index: 0,
        value_status: 'observed',
        value_num: 12,
        value_text: null,
        unit_code: 'unit.mm_water',
        entered_value_num: 12,
        entered_unit_code: 'unit.mm_water',
    }],
};
const customVocab = {
    contract_version: 1,
    base_sync_version: 0,
    code: `custom.${UUID}`,
    kind: 'attribute',
    parent_code: null,
    value_type: 'text',
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    labels_json: '{"en":"Operator note"}',
    icon_key: null,
    constraints_json: null,
    agrovoc_uri: null,
    icasa_code: null,
    adapt_code: null,
    scope: 'custom',
    owner_user_uuid: COMPACT_UUID,
    gateway_device_eui: '0016C001F11715E2',
    custom_field_uuid: UUID,
    active: 1,
    sort_order: 0,
    sync_version: 1,
    created_at: '2026-07-13T08:00:00.000Z',
    deleted_at: null,
    mappings: [{
        scheme_uri: 'https://example.test/vocab',
        scheme_version: '1',
        mapping_role: 'concept',
        external_id: 'operator-note',
        external_parent_id: null,
        mapping_relation: 'exact',
        source_uri: null,
        active: 1,
    }],
};
const plot = {
    contract_version: 1,
    base_sync_version: 0,
    plot_uuid: UUID,
    owner_user_uuid: COMPACT_UUID,
    plot_code: 'LYS-02',
    name: 'Lysimeter 2',
    zone_uuid: null,
    station_code: 'RECKENHOLZ',
    crop_hint: 'barley',
    area_m2: 4,
    active: 1,
    sync_version: 1,
    gateway_device_eui: '0016C001F11715E2',
    created_at: '2026-07-13T08:00:00.000Z',
    updated_at: '2026-07-13T08:00:00.000Z',
    deleted_at: null,
    settings: {
        layout_code: 'open_field',
        updated_at: '2026-07-13T08:00:00.000Z',
        updated_by_principal_uuid: COMPACT_UUID,
        sync_version: 1,
    },
};
const plotGroup = {
    contract_version: 1,
    base_sync_version: 0,
    group_uuid: UUID,
    owner_user_uuid: COMPACT_UUID,
    label: 'Barley 2026',
    gateway_device_eui: '0016C001F11715E2',
    created_by_principal_uuid: UUID,
    created_at: '2026-07-13T08:00:00.000Z',
    resolved_at: null,
    resolved_by_principal_uuid: null,
    sync_version: 1,
    deleted_at: null,
    members: [UUID],
};

const resourceSamples = {
    JournalEntry: journalEntry,
    JournalVocab: customVocab,
    JournalPlot: plot,
    JournalPlotGroup: plotGroup,
};
const eventResourceSamples = Object.assign({}, resourceSamples, {
    JournalEntry: Object.assign({}, journalEntry),
    JournalVocab: Object.assign({}, customVocab),
    JournalPlot: Object.assign({}, plot),
    JournalPlotGroup: Object.assign({}, plotGroup),
});
for (const sample of Object.values(eventResourceSamples)) delete sample.base_sync_version;

expectValid('legacy Uuid accepts compact form', resourcesSchema.definitions.Uuid, COMPACT_UUID, resourcesSchema);
expectValid('legacy Uuid accepts fully hyphenated form', resourcesSchema.definitions.Uuid, UUID, resourcesSchema);
expectInvalid(
    'legacy Uuid rejects partial hyphenation',
    resourcesSchema.definitions.Uuid,
    '12345678-12344234-8234-123456789abc',
    /pattern|match/,
    resourcesSchema
);
for (const definitionName of ['CanonicalUuid', 'NullableCanonicalUuid']) {
    reportCheck(
        Boolean(resourcesSchema.definitions[definitionName]),
        `resource schema defines ${definitionName}`,
        `resource schema is missing ${definitionName}`
    );
}
expectValid('CanonicalUuid accepts lowercase hyphenated form', resourcesSchema.definitions.CanonicalUuid, UUID, resourcesSchema);
for (const invalidUuid of [
    UUID.toUpperCase(),
    COMPACT_UUID,
    '12345678-12344234-8234-123456789abc',
]) {
    expectInvalid(
        `CanonicalUuid rejects ${invalidUuid}`,
        resourcesSchema.definitions.CanonicalUuid,
        invalidUuid,
        /pattern|match/,
        resourcesSchema
    );
}

for (const [definitionName, sample] of Object.entries(eventResourceSamples)) {
    const aggregateName = `${definitionName}Aggregate`;
    const aggregateSchema = resourcesSchema.definitions[aggregateName];
    reportCheck(
        Boolean(aggregateSchema),
        `resource schema defines ${aggregateName}`,
        `resource schema is missing ${aggregateName}`
    );
    expectValid(`${aggregateName} complete persisted shape`, aggregateSchema, sample, resourcesSchema);
    const persistedProperties = Object.keys(resourcesSchema.definitions[definitionName].properties)
        .filter((property) => property !== 'base_sync_version');
    for (const property of persistedProperties) {
        const incomplete = Object.assign({}, sample);
        delete incomplete[property];
        expectInvalid(
            `${aggregateName} without persisted ${property}`,
            aggregateSchema,
            incomplete,
            new RegExp(`${property}.*required`),
            resourcesSchema
        );
    }
    expectInvalid(
        `${aggregateName} rejects command-only base_sync_version`,
        aggregateSchema,
        Object.assign({}, sample, { base_sync_version: 0 }),
        /base_sync_version.*forbidden|matches forbidden/,
        resourcesSchema
    );
}

for (const [definitionName, identityPaths] of [
    ['JournalEntryAggregate', ['owner_user_uuid', 'author_principal_uuid']],
    ['JournalVocabAggregate', ['owner_user_uuid']],
    ['JournalPlotAggregate', ['owner_user_uuid']],
    ['JournalPlotGroupAggregate', ['owner_user_uuid']],
]) {
    const sampleName = definitionName.replace(/Aggregate$/, '');
    for (const identityPath of identityPaths) {
        for (const compatibleUuid of [COMPACT_UUID, UUID.toUpperCase()]) {
            const compatible = jsonClone(eventResourceSamples[sampleName]);
            setValueAtPath(compatible, identityPath, compatibleUuid);
            expectValid(
                `${definitionName} keeps legacy ${identityPath} compatibility for ${compatibleUuid}`,
                resourcesSchema.definitions[definitionName],
                compatible,
                resourcesSchema
            );
        }
    }
}

for (const [definitionName, sample] of [
    ['JournalEntryValue', eventResourceSamples.JournalEntry.values[0]],
    ['JournalVocabMapping', eventResourceSamples.JournalVocab.mappings[0]],
    ['JournalPlotSettings', eventResourceSamples.JournalPlot.settings],
]) {
    const definition = resourcesSchema.definitions[definitionName];
    reportCheck(Boolean(definition), `resource schema defines ${definitionName}`, `resource schema is missing ${definitionName}`);
    for (const property of Object.keys(sample)) {
        const incomplete = Object.assign({}, sample);
        delete incomplete[property];
        expectInvalid(
            `${definitionName} without persisted ${property}`,
            definition,
            incomplete,
            new RegExp(`${property}.*required`),
            resourcesSchema
        );
    }
}

const observedValue = eventResourceSamples.JournalEntry.values[0];
expectInvalid(
    'observed JournalEntryValue rejects both numeric and text values',
    resourcesSchema.definitions.JournalEntryValue,
    Object.assign({}, observedValue, { value_text: 'twelve' }),
    /oneOf|observed/,
    resourcesSchema
);
expectInvalid(
    'observed JournalEntryValue rejects no value',
    resourcesSchema.definitions.JournalEntryValue,
    Object.assign({}, observedValue, { value_num: null, value_text: null }),
    /oneOf|observed/,
    resourcesSchema
);
expectInvalid(
    'non-observed JournalEntryValue rejects a carried value',
    resourcesSchema.definitions.JournalEntryValue,
    Object.assign({}, observedValue, { value_status: 'not_observed' }),
    /oneOf|non-observed|constant/,
    resourcesSchema
);

const journalIdentityCases = [
    ['JournalEntryAggregate', eventResourceSamples.JournalEntry, 'entry_uuid'],
    ['JournalEntryAggregate', eventResourceSamples.JournalEntry, 'plot_uuid'],
    ['JournalEntryAggregate', eventResourceSamples.JournalEntry, 'batch_uuid'],
    ['JournalVocabAggregate', eventResourceSamples.JournalVocab, 'custom_field_uuid'],
    ['JournalPlotAggregate', eventResourceSamples.JournalPlot, 'plot_uuid'],
    ['JournalPlotGroupAggregate', eventResourceSamples.JournalPlotGroup, 'group_uuid'],
    ['JournalPlotGroupAggregate', eventResourceSamples.JournalPlotGroup, 'members.0'],
];
for (const [definitionName, sample, identityPath] of journalIdentityCases) {
    for (const invalidUuid of [
        UUID.toUpperCase(),
        COMPACT_UUID,
        '12345678-12344234-8234-123456789abc',
    ]) {
        const invalid = jsonClone(sample);
        setValueAtPath(invalid, identityPath, invalidUuid);
        expectInvalid(
            `${definitionName} rejects non-canonical ${identityPath} ${invalidUuid}`,
            resourcesSchema.definitions[definitionName],
            invalid,
            /pattern|match/,
            resourcesSchema
        );
    }
}

const journalTimestampPaths = {
    JournalEntryAggregate: [
        'occurred_start', 'occurred_end', 'recorded_at', 'voided_at', 'created_at', 'updated_at', 'deleted_at',
    ],
    JournalVocabAggregate: ['created_at', 'deleted_at'],
    JournalPlotAggregate: ['created_at', 'updated_at', 'deleted_at', 'settings.updated_at'],
    JournalPlotGroupAggregate: ['created_at', 'resolved_at', 'deleted_at'],
};
for (const [definitionName, timestampPaths] of Object.entries(journalTimestampPaths)) {
    const sampleName = definitionName.replace(/Aggregate$/, '');
    for (const timestampPath of timestampPaths) {
        for (const invalidTimestamp of [
            '2026-07-13T10:00:00.000+02:00',
            '2026-07-13T08:00:00Z',
            '2026-02-30T08:00:00.000Z',
        ]) {
            const invalid = jsonClone(eventResourceSamples[sampleName]);
            setValueAtPath(invalid, timestampPath, invalidTimestamp);
            expectInvalid(
                `${definitionName} rejects ${timestampPath}=${invalidTimestamp}`,
                resourcesSchema.definitions[definitionName],
                invalid,
                /does not match|format.*date-time/,
                resourcesSchema
            );
        }
    }
}

const storedEntryRow = Object.assign({ id: 7, user_id: 3, zone_id: 2 }, eventResourceSamples.JournalEntry);
delete storedEntryRow.values;
const storedValueRows = journalEntry.values.map((value, index) =>
    Object.assign({ id: index + 1, entry_uuid: UUID }, value)
);
const builtEntryAggregate = JOURNAL_AGGREGATE.buildAggregate(storedEntryRow, storedValueRows);
const builtAggregateErrors = validationErrors(
    resourcesSchema.definitions.JournalEntry,
    builtEntryAggregate,
    resourcesSchema
);
reportCheck(
    builtAggregateErrors.length === 0 && !Object.prototype.hasOwnProperty.call(builtEntryAggregate, 'base_sync_version'),
    'actual JournalEntry aggregate builder output validates without base_sync_version',
    `actual JournalEntry aggregate builder output rejected: ${builtAggregateErrors.join('; ')}`
);

const lifecycleSource = fs.readFileSync(
    path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/lifecycle.js'),
    'utf8'
);
const entryColumnsMatch = /const ENTRY_COLUMNS = \[([\s\S]*?)\];/.exec(lifecycleSource);
const storedEntryColumns = entryColumnsMatch
    ? [...entryColumnsMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
    : [];
const aggregateEntryColumns = storedEntryColumns.filter((column) => !['id', 'user_id', 'zone_id'].includes(column));
const journalEntryProperties = Object.keys(resourcesSchema.definitions.JournalEntry.properties);
const missingAggregateFields = aggregateEntryColumns.filter((column) => !journalEntryProperties.includes(column));
const unknownResourceFields = journalEntryProperties.filter((column) =>
    !aggregateEntryColumns.includes(column) && !['contract_version', 'base_sync_version', 'values'].includes(column)
);
reportCheck(
    Boolean(entryColumnsMatch) && missingAggregateFields.length === 0 && unknownResourceFields.length === 0,
    'JournalEntry resource fields match the lifecycle aggregate projection',
    `JournalEntry field drift: missing=${missingAggregateFields.join(',') || '(none)'} unknown=${unknownResourceFields.join(',') || '(none)'}`
);

for (const [op, binding] of Object.entries(JOURNAL_EVENT_BINDINGS)) {
    const [aggregateType, definitionName, watermarkKey] = binding;
    const definition = resourcesSchema.definitions[definitionName];
    reportCheck(
        definition && definition.additionalProperties === false &&
            definition['x-aggregate-type'] === aggregateType &&
            definition['x-watermark-key'] === watermarkKey &&
            Array.isArray(definition.required) && definition.required.includes(watermarkKey),
        `resource ${definitionName} is strict and pins ${aggregateType}/${watermarkKey}`,
        `resource ${definitionName} is not strict or lacks aggregate/watermark metadata`
    );
    const rule = (eventsSchema.allOf || []).find((candidate) =>
        candidate.if && candidate.if.properties && candidate.if.properties.op &&
        candidate.if.properties.op.const === op
    );
    const ruleAggregate = rule && rule.then && rule.then.properties && rule.then.properties.aggregateType;
    const rulePayload = rule && rule.then && rule.then.properties && rule.then.properties.payload;
    const rulePayloadRef = rulePayload && (rulePayload.$ref ||
        (Array.isArray(rulePayload.allOf) && rulePayload.allOf[0] && rulePayload.allOf[0].$ref));
    reportCheck(
        ruleAggregate && ruleAggregate.const === aggregateType &&
            rulePayloadRef === `resources.schema.json#/definitions/${definitionName}Aggregate`,
        `event ${op} binds ${aggregateType} to ${definitionName}Aggregate`,
        `event ${op} lacks the exact aggregate/resource binding`
    );
}

for (const definitionName of ['JournalEntry', 'JournalVocab', 'JournalPlot', 'JournalPlotGroup']) {
    const withoutGateway = Object.assign({}, eventResourceSamples[definitionName]);
    delete withoutGateway.gateway_device_eui;
    const errors = validationErrors(resourcesSchema.definitions[definitionName], withoutGateway, resourcesSchema);
    reportCheck(
        errors.some((error) => /gateway_device_eui.*required/.test(error)),
        `${definitionName} requires its gateway tenant key`,
        `${definitionName} accepts a missing gateway_device_eui: ${errors.join('; ')}`
    );
}
const plotWithoutSettings = Object.assign({}, eventResourceSamples.JournalPlot);
delete plotWithoutSettings.settings;
const plotSettingsErrors = validationErrors(resourcesSchema.definitions.JournalPlot, plotWithoutSettings, resourcesSchema);
reportCheck(
    plotSettingsErrors.some((error) => /settings.*required/.test(error)),
    'JournalPlot requires its layout settings aggregate',
    `JournalPlot accepts missing layout settings: ${plotSettingsErrors.join('; ')}`
);

const journalScopeRule = allOf.find((rule) =>
    rule.if && rule.if.properties && rule.if.properties.command_type &&
    Array.isArray(rule.if.properties.command_type.enum) &&
    rule.else && Array.isArray(rule.else.required) && rule.else.required.includes('device_eui')
);
reportCheck(
    journalScopeRule && JSON.stringify(journalScopeRule.if.properties.command_type.enum) === JSON.stringify(DEVICE_EUI_EXEMPT_COMMANDS),
    'gateway-resource commands are the exact device_eui exemptions',
    'device_eui exemption is missing or does not match gateway-resource commands'
);

const trustedCommandIdentity = {
    owner_user_uuid: UUID,
    author_principal_uuid: UUID,
    author_label: 'Cloud researcher',
};
const commandFixtures = [
    {
        ...trustedCommandIdentity,
        command_type: 'UPSERT_JOURNAL_ENTRY',
        command_id: UUID,
        effect_key: `journal_entry:${UUID}:0`,
        entry: Object.assign({}, journalEntry, {
            owner_user_uuid: UUID,
            author_principal_uuid: UUID,
            author_label: 'Cloud researcher',
        }),
    },
    {
        ...trustedCommandIdentity,
        command_type: 'VOID_JOURNAL_ENTRY',
        command_id: UUID,
        effect_key: `journal_entry:${UUID}:1`,
        entry_uuid: UUID,
        base_sync_version: 1,
        reason: 'Entered against the wrong plot',
    },
    {
        ...trustedCommandIdentity,
        command_type: 'UPSERT_JOURNAL_CUSTOM_VOCAB',
        command_id: UUID,
        effect_key: `journal_vocab:${UUID}:0`,
        custom_vocab: Object.assign({}, customVocab, { owner_user_uuid: UUID }),
    },
    {
        ...trustedCommandIdentity,
        command_type: 'UPSERT_JOURNAL_PLOT',
        command_id: UUID,
        effect_key: `journal_plot:${UUID}:0`,
        plot: Object.assign({}, plot, { owner_user_uuid: UUID }),
    },
    {
        ...trustedCommandIdentity,
        command_type: 'UPSERT_JOURNAL_PLOT_GROUP',
        command_id: UUID,
        effect_key: `journal_plot_group:${UUID}:0`,
        plot_group: Object.assign({}, plotGroup, { owner_user_uuid: UUID }),
    },
];
for (const [fixtureIndex, payloadKey, identityPaths] of [
    [0, 'entry', ['owner_user_uuid', 'author_principal_uuid']],
    [2, 'custom_vocab', ['owner_user_uuid']],
    [3, 'plot', ['owner_user_uuid']],
    [4, 'plot_group', ['owner_user_uuid']],
]) {
    const fixture = commandFixtures[fixtureIndex];
    for (const identityPath of identityPaths) {
        for (const invalidUuid of [COMPACT_UUID, UUID.toUpperCase()]) {
            const invalid = jsonClone(fixture);
            setValueAtPath(invalid[payloadKey], identityPath, invalidUuid);
            expectInvalid(
                `${fixture.command_type} rejects nested ${identityPath} ${invalidUuid}`,
                cmdSchema,
                invalid,
                new RegExp(`${identityPath}.*(?:match|pattern)`)
            );
        }
    }
}
reportCheck(
    JSON.stringify(cmdSchema['x-semantic-bindings']) === JSON.stringify(EXPECTED_COMMAND_SEMANTIC_BINDINGS),
    'command schema pins exact effect-key semantic bindings',
    'command schema lacks the exact effect-key semantic bindings'
);
for (const fixture of commandFixtures) {
    expectValid(`${fixture.command_type} without device_eui`, cmdSchema, fixture);
    const missingEffect = Object.assign({}, fixture);
    delete missingEffect.effect_key;
    expectInvalid(`${fixture.command_type} without effect_key`, cmdSchema, missingEffect, /effect_key.*required/);
    expectInvalid(
        `${fixture.command_type} with malformed effect_key`,
        cmdSchema,
        Object.assign({}, fixture, { effect_key: 'journal:malformed' }),
        /effect_key.*match/
    );
    expectInvalid(
        `${fixture.command_type} with non-canonical UUID in effect_key`,
        cmdSchema,
        Object.assign({}, fixture, { effect_key: fixture.effect_key.replace(UUID, UUID.toUpperCase()) }),
        /effect_key.*match/
    );
    expectInvalid(
        `${fixture.command_type} with padded base version in effect_key`,
        cmdSchema,
        Object.assign({}, fixture, { effect_key: fixture.effect_key.replace(/:[0-9]+$/, ':00') }),
        /effect_key.*match|must equal/
    );
    expectInvalid(
        `${fixture.command_type} with mismatched UUID in effect_key`,
        cmdSchema,
        Object.assign({}, fixture, {
            effect_key: fixture.effect_key.replace(UUID, '87654321-4321-4321-8321-cba987654321'),
        }),
        /effect_key.*must equal/
    );
    const mismatchedBase = jsonClone(fixture);
    if (mismatchedBase.entry) mismatchedBase.entry.base_sync_version += 1;
    else if (mismatchedBase.custom_vocab) mismatchedBase.custom_vocab.base_sync_version += 1;
    else if (mismatchedBase.plot) mismatchedBase.plot.base_sync_version += 1;
    else if (mismatchedBase.plot_group) mismatchedBase.plot_group.base_sync_version += 1;
    else mismatchedBase.base_sync_version += 1;
    expectInvalid(
        `${fixture.command_type} with mismatched base version in effect_key`,
        cmdSchema,
        mismatchedBase,
        /effect_key.*must equal/
    );
}

for (const identityField of ['owner_user_uuid', 'author_principal_uuid', 'author_label']) {
    const missingIdentity = Object.assign({}, commandFixtures[0]);
    delete missingIdentity[identityField];
    expectInvalid(
        `UPSERT_JOURNAL_ENTRY without trusted ${identityField}`,
        cmdSchema,
        missingIdentity,
        new RegExp(`${identityField}.*required`)
    );
}
expectValid(
    'UPSERT_JOURNAL_ENTRY accepts one canonical duplicate acknowledgement control',
    cmdSchema,
    Object.assign({}, commandFixtures[0], { duplicate_guard_ack_entry_uuid: UUID })
);
for (const invalidAcknowledgement of [UUID.toUpperCase(), COMPACT_UUID, 'not-a-uuid']) {
    expectInvalid(
        `UPSERT_JOURNAL_ENTRY rejects duplicate acknowledgement ${invalidAcknowledgement}`,
        cmdSchema,
        Object.assign({}, commandFixtures[0], {
            duplicate_guard_ack_entry_uuid: invalidAcknowledgement,
        }),
        /duplicate_guard_ack_entry_uuid.*(?:match|forbidden|enum)/
    );
}
for (const fixture of commandFixtures.slice(1)) {
    expectInvalid(
        `${fixture.command_type} rejects duplicate_guard_ack_entry_uuid`,
        cmdSchema,
        Object.assign({}, fixture, { duplicate_guard_ack_entry_uuid: UUID }),
        /duplicate_guard_ack_entry_uuid.*(?:forbidden|enum)/
    );
}
expectValid(
    'journal command accepts an explicit null author label',
    cmdSchema,
    Object.assign({}, commandFixtures[0], {
        author_label: null,
        entry: Object.assign({}, commandFixtures[0].entry, { author_label: null }),
    })
);
expectInvalid(
    'journal command rejects an oversized author label',
    cmdSchema,
    Object.assign({}, commandFixtures[0], { author_label: 'x'.repeat(121) }),
    /author_label.*longer/
);

expectInvalid(
    'UPSERT_JOURNAL_ENTRY rejects draft status',
    cmdSchema,
    Object.assign({}, commandFixtures[0], {
        entry: Object.assign({}, commandFixtures[0].entry, { status: 'draft' }),
    }),
    /status.*constant/
);

for (const [commandType, payloadKey] of [
    ['UPSERT_JOURNAL_ENTRY', 'entry'],
    ['UPSERT_JOURNAL_CUSTOM_VOCAB', 'custom_vocab'],
    ['UPSERT_JOURNAL_PLOT', 'plot'],
    ['UPSERT_JOURNAL_PLOT_GROUP', 'plot_group'],
]) {
    const fixture = commandFixtures.find((candidate) => candidate.command_type === commandType);
    const payloadWithoutBase = Object.assign({}, fixture[payloadKey]);
    delete payloadWithoutBase.base_sync_version;
    expectInvalid(
        `${commandType} without embedded base_sync_version`,
        cmdSchema,
        Object.assign({}, fixture, { [payloadKey]: payloadWithoutBase }),
        /base_sync_version.*required/
    );
}

const invalidCustomCode = Object.assign({}, customVocab, { code: 'custom.operator_note' });
expectInvalid(
    'custom vocabulary without custom.<UUID> code',
    cmdSchema,
    Object.assign({}, commandFixtures[2], { custom_vocab: invalidCustomCode }),
    /code.*match/
);
for (const invalidCode of [
    `custom.${UUID.toUpperCase()}`,
    `custom.${COMPACT_UUID}`,
    'custom.12345678-12344234-8234-123456789abc',
]) {
    expectInvalid(
        `custom vocabulary rejects non-canonical code ${invalidCode}`,
        cmdSchema,
        Object.assign({}, commandFixtures[2], {
            custom_vocab: Object.assign({}, customVocab, { code: invalidCode }),
        }),
        /code.*match/
    );
}
for (const timestampField of ['issued_at', 'expires_at']) {
    for (const invalidTimestamp of [
        '2026-07-13T10:00:00.000+02:00',
        '2026-07-13T08:00:00Z',
        '2026-02-30T08:00:00.000Z',
    ]) {
        expectInvalid(
            `journal command rejects ${timestampField}=${invalidTimestamp}`,
            cmdSchema,
            Object.assign({}, commandFixtures[0], { [timestampField]: invalidTimestamp }),
            new RegExp(`${timestampField}.*(?:match|format)`)
        );
    }
}
expectValid(
    'journal command permits an explicit null expiry',
    cmdSchema,
    Object.assign({}, commandFixtures[0], { expires_at: null })
);

const wrongJournalPayload = Object.assign({}, commandFixtures[0], { plot });
delete wrongJournalPayload.entry;
expectInvalid('UPSERT_JOURNAL_ENTRY with plot payload', cmdSchema, wrongJournalPayload, /entry.*required|plot.*forbidden|plot.*enum/);
expectInvalid(
    'UPSERT_JOURNAL_ENTRY with null effect_key',
    cmdSchema,
    Object.assign({}, commandFixtures[0], { effect_key: null }),
    /effect_key.*string/
);
expectInvalid(
    'VOID_JOURNAL_ENTRY with oversized reason',
    cmdSchema,
    Object.assign({}, commandFixtures[1], { reason: 'x'.repeat(4001) }),
    /reason.*longer/
);
expectInvalid(
    'unknown journal-like command',
    cmdSchema,
    { command_type: 'UPSERT_JOURNAL_UNKNOWN', command_id: UUID, effect_key: 'journal:unknown' },
    /command_type.*enum/
);

const existingCommandEnvelope = {
    command_id: UUID,
    duration_seconds: 1,
    amount: 1,
    request_id: 'request-1',
    status: 'APPLIED',
};
for (const commandType of cmdSchema.properties.command_type.enum.filter((type) => !DEVICE_EUI_EXEMPT_COMMANDS.includes(type))) {
    expectInvalid(
        `${commandType} without device_eui`,
        cmdSchema,
        Object.assign({ command_type: commandType }, existingCommandEnvelope),
        /device_eui.*required/
    );
}
expectValid(
    'existing REBOOT command with device_eui',
    cmdSchema,
    { command_type: 'REBOOT', command_id: UUID, device_eui: '0016C001F11715E2' }
);

reportCheck(
    JSON.stringify(eventsSchema['x-semantic-bindings']) === JSON.stringify(EXPECTED_EVENT_SEMANTIC_BINDINGS),
    'event schema pins exact aggregate watermark and version bindings',
    'event schema lacks the exact aggregate watermark and version bindings'
);
for (const [op, binding] of Object.entries(JOURNAL_EVENT_BINDINGS)) {
    const [aggregateType, definitionName, watermarkKey] = binding;
    const payload = op === 'JOURNAL_ENTRY_VOIDED'
        ? Object.assign({}, eventResourceSamples[definitionName], {
            status: 'voided',
            voided_at: '2026-07-13T08:02:00.000Z',
            voided_by_principal_uuid: COMPACT_UUID,
            void_reason: 'Entered against the wrong plot',
        })
        : eventResourceSamples[definitionName];
    const event = {
        eventUuid: UUID,
        aggregateType,
        aggregateKey: payload[watermarkKey],
        op,
        syncVersion: payload.sync_version,
        occurredAt: '2026-07-13T08:01:00.000Z',
        payload,
    };
    expectValid(`${op} flat payload`, eventsSchema, event);
    expectInvalid(
        `${op} rejects command-only base_sync_version`,
        eventsSchema,
        Object.assign({}, event, { payload: Object.assign({}, payload, { base_sync_version: 0 }) }),
        /base_sync_version.*forbidden|matches forbidden/
    );
    expectInvalid(
        `${op} rejects aggregateKey mismatched from ${watermarkKey}`,
        eventsSchema,
        Object.assign({}, event, { aggregateKey: '87654321-4321-4321-8321-cba987654321' }),
        /aggregateKey.*must equal/
    );
    expectInvalid(
        `${op} rejects syncVersion mismatched from payload.sync_version`,
        eventsSchema,
        Object.assign({}, event, { syncVersion: payload.sync_version + 1 }),
        /syncVersion.*must equal/
    );
    for (const invalidKey of [UUID.toUpperCase(), COMPACT_UUID, '12345678-12344234-8234-123456789abc']) {
        expectInvalid(
            `${op} rejects non-canonical aggregateKey ${invalidKey}`,
            eventsSchema,
            Object.assign({}, event, { aggregateKey: invalidKey }),
            /aggregateKey.*match/
        );
    }
    for (const invalidTimestamp of [
        '2026-07-13T10:01:00.000+02:00',
        '2026-07-13T08:01:00Z',
        '2026-02-30T08:01:00.000Z',
    ]) {
        expectInvalid(
            `${op} rejects occurredAt=${invalidTimestamp}`,
            eventsSchema,
            Object.assign({}, event, { occurredAt: invalidTimestamp }),
            /occurredAt.*(?:match|format)/
        );
    }
    expectInvalid(
        `${op} wrong aggregateType`,
        eventsSchema,
        Object.assign({}, event, { aggregateType: 'JOURNAL_WRONG' }),
        /aggregateType.*constant/
    );
    const missingWatermark = Object.assign({}, payload);
    delete missingWatermark[watermarkKey];
    expectInvalid(
        `${op} payload without ${watermarkKey}`,
        eventsSchema,
        Object.assign({}, event, { payload: missingWatermark }),
        new RegExp(`${watermarkKey}.*required`)
    );
    if (op === 'JOURNAL_ENTRY_UPSERTED' || op === 'JOURNAL_ENTRY_VOIDED') {
        const wrongStatus = op === 'JOURNAL_ENTRY_UPSERTED' ? 'voided' : 'final';
        expectInvalid(
            `${op} payload with ${wrongStatus} status`,
            eventsSchema,
            Object.assign({}, event, { payload: Object.assign({}, payload, { status: wrongStatus }) }),
            /status.*constant/
        );
    }
    const missingOccurredAt = Object.assign({}, event);
    delete missingOccurredAt.occurredAt;
    expectInvalid(
        `${op} rejects missing occurredAt`,
        eventsSchema,
        missingOccurredAt,
        /occurredAt.*required/
    );
    expectInvalid(
        `${op} rejects null occurredAt`,
        eventsSchema,
        Object.assign({}, event, { occurredAt: null }),
        /occurredAt.*(?:string|type)/
    );
    if (op === 'JOURNAL_ENTRY_VOIDED') {
        for (const [field, replacement] of [
            ['voided_at', null],
            ['voided_by_principal_uuid', null],
            ['void_reason', null],
            ['void_reason', ''],
        ]) {
            expectInvalid(
                `${op} rejects ${field}=${JSON.stringify(replacement)}`,
                eventsSchema,
                Object.assign({}, event, { payload: Object.assign({}, payload, { [field]: replacement }) }),
                new RegExp(`${field}.*(?:string|shorter|non-null)`)
            );
        }
    }
}
expectInvalid(
    'JOURNAL_ENTRY_UPSERTED rejects void_reason over 4000 characters',
    eventsSchema,
    {
        eventUuid: UUID,
        aggregateType: 'JOURNAL_ENTRY',
        aggregateKey: UUID,
        op: 'JOURNAL_ENTRY_UPSERTED',
        syncVersion: 1,
        occurredAt: '2026-07-13T08:01:00.000Z',
        payload: Object.assign({}, eventResourceSamples.JournalEntry, { void_reason: 'x'.repeat(4001) }),
    },
    /void_reason.*longer/
);
expectInvalid(
    'JOURNAL_ENTRY_UPSERTED double-nested payload',
    eventsSchema,
    {
        eventUuid: UUID,
        aggregateType: 'JOURNAL_ENTRY',
        aggregateKey: UUID,
        op: 'JOURNAL_ENTRY_UPSERTED',
        syncVersion: 1,
        payload: { contract_version: 1, entry: journalEntry },
    },
    /entry_uuid.*required|entry.*forbidden/
);
expectInvalid(
    'unknown journal-like event op',
    eventsSchema,
    {
        eventUuid: UUID,
        aggregateType: 'JOURNAL_ENTRY',
        aggregateKey: UUID,
        op: 'JOURNAL_ENTRY_UNKNOWN',
        syncVersion: 1,
        payload: journalEntry,
    },
    /op.*enum/
);

const effectKeyDoc = fs.readFileSync(path.join(SCHEMA_DIR, 'effect-keys.md'), 'utf8');
for (const format of [
    'journal_entry:{entry_uuid}:{base_sync_version}',
    'journal_vocab:{custom_field_uuid}:{base_sync_version}',
    'journal_plot:{plot_uuid}:{base_sync_version}',
    'journal_plot_group:{group_uuid}:{base_sync_version}',
    'scoped_user:{user_uuid}:{base_sync_version}',
    'scoped_user_password:{user_uuid}:{base_sync_version}',
    'scoped_zone_assignment:{assignment_uuid}:{base_sync_version}',
    'scoped_plot_assignment:{assignment_uuid}:{base_sync_version}',
    'zone:{zone_uuid}:{base_sync_version}',
    'zone_delete:{zone_uuid}:{base_sync_version}',
]) {
    reportCheck(
        effectKeyDoc.includes(format),
        `effect-key contract pins ${format}`,
        `effect-key contract missing ${format}`
    );
}

const fieldJournalWorkflow = fs.readFileSync(
    path.resolve(__dirname, '../.github/workflows/field-journal.yml'),
    'utf8'
);
for (const command of [
    'node scripts/verify-sync-contract.js',
    'node scripts/test-contract-schemas.js',
    'node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js',
]) {
    const matchingRuns = fieldJournalWorkflow.split(/\r?\n/)
        .filter((line) => line.trim() === `run: ${command}`);
    reportCheck(
        matchingRuns.length === 1,
        `Field Journal CI runs ${command} exactly once`,
        `Field Journal CI must run ${command} exactly once; found ${matchingRuns.length}`
    );
}

if (!ok) process.exit(1);
console.log('PASS: contract schema checks pass');
