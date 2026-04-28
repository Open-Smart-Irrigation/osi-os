const fs = require('fs');

// Runtime config precedence:
// 1. node-red.init exports UCI values first.
// 2. node-red.init falls back per key to /srv/node-red/.chirpstack.env.
// 3. This loader fills only still-missing non-identity keys for non-procd starts.
const chirpstackEnvPath = '/srv/node-red/.chirpstack.env';
const protectedKeys = new Set([
    'DEVICE_EUI',
    'DEVICE_EUI_SOURCE',
    'DEVICE_EUI_CONFIDENCE',
    'DEVICE_EUI_LAST_VERIFIED_AT',
    'LINK_GATEWAY_DEVICE_EUI'
]);

function loadChirpstackEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const equalsIndex = trimmed.indexOf('=');
        if (equalsIndex <= 0) continue;
        const key = trimmed.slice(0, equalsIndex).trim();
        let value = trimmed.slice(equalsIndex + 1).trim();
        value = value.replace(/^['"]|['"]$/g, '');
        if (!key || protectedKeys.has(key)) continue;
        if (process.env[key]) continue;
        process.env[key] = value;
        if (process.env.LOG_CHIRPSTACK_ENV_LOADS === '1') {
            console.log(`[settings] loaded ${key} from .chirpstack.env`);
        }
    }
}

loadChirpstackEnvFile(chirpstackEnvPath);

module.exports = {
    flowFile: "flows.json",
    userDir: "/var/lib/node-red/.node-red",
    uiPort: process.env.PORT || 1880,

    // Serve React GUI at /gui path
    httpStatic: '/usr/lib/node-red/gui',
    httpStaticRoot: '/gui',

    mqttReconnectTime: 15000,
    serialReconnectTime: 15000,
    debugMaxLength: 1000,

    functionExternalModules: true,

    functionGlobalContext: {
        os: require('os'),
        fs: require('fs'),
        cp: require('child_process'),
    },

    exportGlobalContextKeys: false,

    logging: {
        console: {
            level: "info",
            metrics: false,
            audit: false
        }
    },

    editorTheme: {
        projects: {
            enabled: false
        }
    }
};
