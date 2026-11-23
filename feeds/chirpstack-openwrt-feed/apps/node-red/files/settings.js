const fs = require('fs');

if (process.env.OSI_NODE_RED_STARTUP_WARNING) {
    console.warn('[node-red.init] ' + process.env.OSI_NODE_RED_STARTUP_WARNING);
}

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

// Read-only check of the farm database (NEW-15), started here in a child
// process beside the flows, which do not wait for it. It reports only. If it
// cannot load, Node-RED still starts and osi-db-helper starts the check at
// its first connection.
try {
    require('/srv/node-red/osi-db-helper/startup').check();
} catch (error) {
    console.error('[osi-db-startup] ERROR farm database start-up check did not run: ' + (error && error.message ? error.message : error));
}

// One-time refresh of local sessions after the sign-in update
// (osi-local-password-reset refreshSessionsOnce: it replaces the local session
// secret once, only when an account still needs the sign-in step, and records a
// marker in /data/db). It runs beside start-up, like the database check above,
// and never stops or delays Node-RED starting.
try {
    require('/srv/node-red/osi-local-password-reset').refreshSessionsOnce({
        fs,
        execFile: require('child_process').execFile,
        crypto: require('crypto'),
        env: process.env,
        warn: (message) => console.warn('[osi-sign-in] ' + message),
    }).then((refresh) => {
        if (refresh && refresh.message) console.log('[osi-sign-in] ' + refresh.message);
    }).catch((error) => {
        console.error('[osi-sign-in] ERROR session refresh failed: ' + (error && error.message ? error.message : error));
    });
} catch (error) {
    console.error('[osi-sign-in] ERROR session refresh did not run: ' + (error && error.message ? error.message : error));
}

// Sign-in step gate (httpNodeMiddleware, runs before every HTTP-in route).
// A token issued while its account must set a new password carries the
// claim mustChangePassword (osi-local-password-reset TOKEN_CLAIM). Such a
// token reaches only GET /api/me and POST /auth/login (where the new password
// is set); every other route answers 403 password_change_required. The gate
// reads the claim without checking the signature: a forged claim can only
// restrict its own request, and the route still verifies every token as
// before. Kept dependency-free so it cannot fail to load.
const SIGN_IN_STEP_ALLOWED = new Set(['GET /api/me', 'POST /auth/login']);

function tokenClaims(authorization) {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
    const body = authorization.slice(7).trim().split('.')[0];
    if (!body) return null;
    try {
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return claims && typeof claims === 'object' ? claims : null;
    } catch (error) {
        // Not a token this gate can read; the route answers it as before.
        return null;
    }
}

function signInStepGate(req, res, next) {
    const claims = tokenClaims(req && req.headers ? req.headers.authorization : undefined);
    if (claims && claims.mustChangePassword === true) {
        const route = String(req.method || '').toUpperCase() + ' ' + String(req.path || '').replace(/\/+$/, '');
        if (!SIGN_IN_STEP_ALLOWED.has(route)) {
            res.status(403).json({ code: 'password_change_required', message: 'Set a new password to continue.' });
            return;
        }
    }
    next();
}

module.exports = {
    flowFile: "flows.json",
    userDir: "/srv/node-red",
    uiPort: process.env.PORT || 1880,

    // Editor/admin API closed by default: an unauthenticated visitor on the
    // shared :1880 listener could otherwise deploy a function node and run
    // code as the gateway's (root) service account. httpAdminRoot: false
    // disables the editor and the /flows, /settings, /nodes admin routes
    // while leaving HTTP-node product routes and httpStatic/httpStaticRoot
    // below untouched on the same listener. Do NOT set uiHost: that would
    // bind the whole listener to loopback and remove LAN access to /gui and
    // /api for every farmer browser on the shared port. Re-enabling the
    // editor for field repair is a deliberate shell/deploy-path operation
    // (see AGENTS.md "Security"), not a config default. Durable per-device
    // adminAuth is a tracked follow-up (see PR body / consult Q3).
    httpAdminRoot: false,

    // Serve React GUI at /gui path
    httpStatic: '/usr/lib/node-red/gui',
    httpStaticRoot: '/gui',

    // Every HTTP-in route passes the sign-in step gate first (see above).
    httpNodeMiddleware: signInStepGate,

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
