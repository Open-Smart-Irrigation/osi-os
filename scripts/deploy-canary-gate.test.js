'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { evaluatePoll, runGate } = require('./deploy-canary-gate');

const EUI = '0016C001F11715E2';
const SINCE = '2026-07-07T12:00:00.000Z';

function gatewayRow(overrides = {}) {
  return {
    gatewayEui: EUI,
    lastSeen: '2026-07-07T12:05:00Z',
    currentStateRecordedAt: '2026-07-07T12:05:00Z',
    heartbeatAgeSeconds: 10,
    heartbeatStatus: 'HEALTHY',
    edgeHealth: {
      status: 'healthy',
      reasons: [],
      schemaSig: 'sig-a',
      syncLinked: true,
      syncOldestAgeSeconds: 5,
      syncRejected: 0,
      diskFreePct: 40,
      errorsTotal: 3,
      errorsLastAt: '2026-07-07T12:04:00Z',
      ...overrides.edgeHealth,
    },
    ...overrides,
    ...(overrides.edgeHealth ? {} : {}),
  };
}

function healthyBody(overrides = {}) {
  return { status: 'healthy', gateways: [gatewayRow(overrides)] };
}

function gateOptions(overrides = {}) {
  return {
    server: overrides.server,
    eui: EUI,
    since: SINCE,
    adminToken: 'tok',
    consecutive: 3,
    intervalMs: 1,
    timeoutMs: 5000,
    minDiskFreePct: 10,
    ...overrides,
  };
}

function startFixtureServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

test('evaluatePoll: all criteria pass', () => {
  const res = evaluatePoll(healthyBody(), {
    eui: EUI,
    sinceMs: Date.parse(SINCE),
    nowMs: Date.parse('2026-07-07T12:05:10Z'),
    minDiskFreePct: 10,
  });
  assert.equal(res.pass, true);
  assert.deepEqual(res.reasons, []);
});

test('evaluatePoll: gateway not found in response fails', () => {
  const res = evaluatePoll({ status: 'healthy', gateways: [] }, {
    eui: EUI,
    sinceMs: Date.parse(SINCE),
    nowMs: Date.parse(SINCE),
    minDiskFreePct: 10,
  });
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['gateway_not_found']);
});

test('evaluatePoll: heartbeat older than 120s fails freshness', () => {
  const res = evaluatePoll(healthyBody({ heartbeatAgeSeconds: 121 }), {
    eui: EUI,
    sinceMs: Date.parse(SINCE),
    nowMs: Date.parse('2026-07-07T12:05:10Z'),
    minDiskFreePct: 10,
  });
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['heartbeat_stale']);
});

test('evaluatePoll: currentStateRecordedAt before --since fails', () => {
  const res = evaluatePoll(
    healthyBody({ currentStateRecordedAt: '2026-07-07T11:59:00Z' }),
    {
      eui: EUI,
      sinceMs: Date.parse(SINCE),
      nowMs: Date.parse('2026-07-07T12:00:05Z'),
      minDiskFreePct: 10,
    }
  );
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['heartbeat_before_deploy']);
});

test('evaluatePoll: server verdict reasons surface verbatim', () => {
  const res = evaluatePoll(
    healthyBody({ edgeHealth: { status: 'unhealthy', reasons: ['schema_sig_not_accepted'] } }),
    {
      eui: EUI,
      sinceMs: Date.parse(SINCE),
      nowMs: Date.parse('2026-07-07T12:05:10Z'),
      minDiskFreePct: 10,
    }
  );
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['schema_sig_not_accepted']);
});

test('evaluatePoll: --expect-schema-sig mismatch fails even with healthy verdict', () => {
  const res = evaluatePoll(
    healthyBody({ edgeHealth: { status: 'healthy', reasons: [], schemaSig: 'sig-old' } }),
    {
      eui: EUI,
      sinceMs: Date.parse(SINCE),
      nowMs: Date.parse('2026-07-07T12:05:10Z'),
      minDiskFreePct: 10,
      expectSchemaSig: 'sig-new',
    }
  );
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['schema_sig_mismatch']);
});

test('evaluatePoll: --expect-schema-sig exact match passes', () => {
  const res = evaluatePoll(
    healthyBody({ edgeHealth: { status: 'healthy', reasons: [], schemaSig: 'sig-new' } }),
    {
      eui: EUI,
      sinceMs: Date.parse(SINCE),
      nowMs: Date.parse('2026-07-07T12:05:10Z'),
      minDiskFreePct: 10,
      expectSchemaSig: 'sig-new',
    }
  );
  assert.equal(res.pass, true);
  assert.deepEqual(res.reasons, []);
});

test('evaluatePoll: --expect-schema-sig suppresses matching server schema reason', () => {
  const res = evaluatePoll(
    healthyBody({
      edgeHealth: {
        status: 'unhealthy',
        reasons: ['schema_sig_not_accepted'],
        schemaSig: 'sig-new',
      },
    }),
    {
      eui: EUI,
      sinceMs: Date.parse(SINCE),
      nowMs: Date.parse('2026-07-07T12:05:10Z'),
      minDiskFreePct: 10,
      expectSchemaSig: 'sig-new',
    }
  );
  assert.equal(res.pass, true);
  assert.deepEqual(res.reasons, []);
});

test('evaluatePoll: disk_free_pct below threshold fails', () => {
  const res = evaluatePoll(
    healthyBody({ edgeHealth: { status: 'healthy', reasons: [], diskFreePct: 9 } }),
    {
      eui: EUI,
      sinceMs: Date.parse(SINCE),
      nowMs: Date.parse('2026-07-07T12:05:10Z'),
      minDiskFreePct: 10,
    }
  );
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['disk_free_low']);
});

test('evaluatePoll: errorsTotal rising past the in-window baseline fails', () => {
  const res = evaluatePoll(
    healthyBody({ edgeHealth: { status: 'healthy', reasons: [], errorsTotal: 5 } }),
    {
      eui: EUI,
      sinceMs: Date.parse(SINCE),
      nowMs: Date.parse('2026-07-07T12:05:10Z'),
      minDiskFreePct: 10,
      errorsBaseline: 3,
    }
  );
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['errors_total_increased']);
});

test('evaluatePoll: errorsTotal absent is tolerated', () => {
  const body = healthyBody();
  delete body.gateways[0].edgeHealth.errorsTotal;
  delete body.gateways[0].edgeHealth.errorsLastAt;
  const res = evaluatePoll(body, {
    eui: EUI,
    sinceMs: Date.parse(SINCE),
    nowMs: Date.parse('2026-07-07T12:05:10Z'),
    minDiskFreePct: 10,
  });
  assert.equal(res.pass, true);
  assert.deepEqual(res.reasons, []);
});

test('evaluatePoll: multiple simultaneous failures all surface', () => {
  const res = evaluatePoll(
    healthyBody({
      heartbeatAgeSeconds: 200,
      edgeHealth: { status: 'unhealthy', reasons: ['sync_rejected'], diskFreePct: 5 },
    }),
    {
      eui: EUI,
      sinceMs: Date.parse(SINCE),
      nowMs: Date.parse('2026-07-07T12:05:10Z'),
      minDiskFreePct: 10,
    }
  );
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons.sort(), ['disk_free_low', 'heartbeat_stale', 'sync_rejected'].sort());
});

test('runGate: requests the sync-health endpoint with bearer auth', async () => {
  let seenUrl = '';
  let seenAuthorization = '';
  const server = await startFixtureServer((req, res) => {
    seenUrl = req.url;
    seenAuthorization = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(healthyBody()));
  });
  try {
    const result = await runGate(gateOptions({
      server: serverUrl(server),
      consecutive: 1,
    }));
    assert.equal(result.ok, true);
    assert.equal(seenUrl, `/api/v1/admin/sync-health?gatewayEui=${encodeURIComponent(EUI)}&limit=1`);
    assert.equal(seenAuthorization, 'Bearer tok');
  } finally {
    server.close();
  }
});

test('runGate: passes after N consecutive healthy polls', async () => {
  let polls = 0;
  const server = await startFixtureServer((req, res) => {
    polls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(healthyBody()));
  });
  try {
    const result = await runGate(gateOptions({ server: serverUrl(server) }));
    assert.equal(result.ok, true);
    assert.ok(polls >= 3, `expected at least 3 polls, got ${polls}`);
  } finally {
    server.close();
  }
});

test('runGate: a failing poll resets the consecutive counter', async () => {
  let polls = 0;
  const server = await startFixtureServer((req, res) => {
    polls += 1;
    const body = polls === 2
      ? healthyBody({ edgeHealth: { status: 'unhealthy', reasons: ['disk_free_low'], diskFreePct: 1 } })
      : healthyBody();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  try {
    const result = await runGate(gateOptions({ server: serverUrl(server) }));
    assert.equal(result.ok, true);
    assert.ok(polls >= 5, `expected reset then re-accumulation, got ${polls} polls`);
  } finally {
    server.close();
  }
});

test('runGate: captures a new error baseline after a failed poll reset', async () => {
  let polls = 0;
  const server = await startFixtureServer((req, res) => {
    polls += 1;
    const bodies = [
      healthyBody({ edgeHealth: { status: 'healthy', reasons: [], errorsTotal: 3 } }),
      healthyBody({ edgeHealth: { status: 'unhealthy', reasons: ['disk_free_low'], diskFreePct: 1, errorsTotal: 5 } }),
      healthyBody({ edgeHealth: { status: 'healthy', reasons: [], errorsTotal: 5 } }),
      healthyBody({ edgeHealth: { status: 'healthy', reasons: [], errorsTotal: 5 } }),
      healthyBody({ edgeHealth: { status: 'healthy', reasons: [], errorsTotal: 5 } }),
    ];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(bodies[Math.min(polls - 1, bodies.length - 1)]));
  });
  try {
    const result = await runGate(gateOptions({ server: serverUrl(server) }));
    assert.equal(result.ok, true);
    assert.equal(polls, 5);
  } finally {
    server.close();
  }
});

test('runGate: fails with last-seen reasons when timeout expires', async () => {
  const server = await startFixtureServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(healthyBody({
      edgeHealth: { status: 'unhealthy', reasons: ['schema_sig_not_accepted'] },
    })));
  });
  try {
    const result = await runGate(gateOptions({
      server: serverUrl(server),
      timeoutMs: 20,
    }));
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes('schema_sig_not_accepted'));
  } finally {
    server.close();
  }
});

test('runGate: HTTP 401/403 is an auth failure, not a poll failure', async () => {
  const server = await startFixtureServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  try {
    await assert.rejects(
      () => runGate(gateOptions({
        server: serverUrl(server),
        adminToken: 'bad-tok',
      })),
      /auth/i
    );
  } finally {
    server.close();
  }
});

test('runGate: missing OSI_ADMIN_TOKEN is a usage error', () => {
  assert.throws(() => require('./deploy-canary-gate').requireAdminToken(undefined), /OSI_ADMIN_TOKEN/);
});
