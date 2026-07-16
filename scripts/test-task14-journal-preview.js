'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const {
  CANONICAL_IDS,
  createTask14JournalPreviewServer,
} = require('./task14-journal-preview');

function request(baseUrl, method, path, body, options = {}) {
  const url = new URL(path, baseUrl);
  const payload = options.rawBody !== undefined
    ? options.rawBody
    : body === undefined ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        ...(options.authenticated === false ? {} : { Authorization: 'Bearer task14-demo-token' }),
        ...(payload == null ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        }),
      },
    }, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = chunks.join('');
        let json;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          text,
          json,
        });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function draftPayload() {
  return {
    entry_uuid: CANONICAL_IDS.draftEntryUuid,
    base_sync_version: 0,
    status: 'draft',
    plot_uuid: CANONICAL_IDS.plotUuid,
    zone_uuid: CANONICAL_IDS.zoneUuid,
    season_crop: 'barley, winter',
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-16T07:30',
    occurred_end_local: null,
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    occurred_end_utc_offset_minutes: null,
    duplicate_guard_ack_entry_uuid: null,
    values: [
      {
        attribute_code: 'attr.crop',
        value_status: 'observed',
        value: 'agroscope.crop.barley_winter',
        value_text: 'agroscope.crop.barley_winter',
      },
      {
        attribute_code: 'attr.irrigation_depth',
        value_status: 'observed',
        value: 12,
        value_num: 12,
        unit_code: 'unit.mm_water',
      },
    ],
    note: 'Task 14 draft',
  };
}

test('Task 14 preview serves the build and a complete mocked journal lifecycle', async (t) => {
  const preview = createTask14JournalPreviewServer();
  await preview.listen();
  t.after(() => preview.close());
  const baseUrl = preview.url();

  const index = await request(baseUrl, 'GET', '/gui/');
  assert.equal(index.statusCode, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.match(index.text, /localStorage\.setItem\(['"]auth_token['"], ['"]task14-demo-token['"]\)/);
  assert.match(index.text, /localStorage\.setItem\(['"]username['"], ['"]demo['"]\)/);

  const assetPath = index.text.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  assert.ok(assetPath, 'built index must reference its generated JavaScript entry');
  const asset = await request(baseUrl, 'GET', assetPath);
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers['content-type'], /javascript/);
  assert.equal(asset.headers['cache-control'], 'no-store');

  const spaFallback = await request(baseUrl, 'GET', '/gui/journal?capture=1');
  assert.equal(spaFallback.statusCode, 200);
  assert.match(spaFallback.headers['content-type'], /text\/html/);

  const zones = await request(baseUrl, 'GET', '/api/irrigation-zones');
  assert.equal(zones.statusCode, 200);
  assert.equal(zones.json[0].zone_uuid, CANONICAL_IDS.zoneUuid);
  assert.equal(zones.json[0].crop_type, 'barley, winter');
  assert.equal(zones.json[0].timezone, 'Europe/Zurich');
  assert.equal(zones.json[0].schedule.enabled, false);

  const catalog = await request(baseUrl, 'GET', '/api/journal/catalog?include=definitions');
  assert.equal(catalog.statusCode, 200);
  assert.ok(catalog.json.catalog_version > 0);
  assert.ok(catalog.json.vocab.some((row) => row.code === 'attr.crop' && row.labels.en === 'Crop'));
  assert.ok(catalog.json.templates.some((row) => row.code === 'farmer_quick' && row.definition));
  assert.ok(catalog.json.layouts.some((row) => row.code === 'open_field' && row.definition));

  const plots = await request(baseUrl, 'GET', '/api/journal/plots');
  assert.equal(plots.statusCode, 200);
  assert.equal(plots.json.plots[0].plot_uuid, CANONICAL_IDS.plotUuid);
  assert.equal(plots.json.plots[0].zone_uuid, CANONICAL_IDS.zoneUuid);

  const finalList = await request(baseUrl, 'GET', '/api/journal/entries?status=final&limit=100');
  assert.equal(finalList.statusCode, 200);
  assert.equal(finalList.json.next_cursor, null);
  assert.equal(finalList.json.entries[0].status, 'final');
  assert.equal(
    finalList.json.entries[0].values.find((row) => row.attribute_code === 'attr.crop').value_text,
    'agroscope.crop.barley_winter',
  );

  const shortlist = await request(
    baseUrl,
    'GET',
    `/api/journal/entries?status=final&plot_uuid=${CANONICAL_IDS.plotUuid}&activity_code=irrigation&limit=100`,
  );
  assert.equal(shortlist.statusCode, 200);
  assert.equal(shortlist.json.entries.length, 1);

  const draft = await request(baseUrl, 'POST', '/api/journal/entries', draftPayload());
  assert.equal(draft.statusCode, 201);
  assert.deepEqual(draft.json, {
    entry_uuid: CANONICAL_IDS.draftEntryUuid,
    sync_version: 0,
  });

  const exactDraft = await request(
    baseUrl,
    'GET',
    `/api/journal/entries?entry_uuid=${CANONICAL_IDS.draftEntryUuid}&status=all&limit=1`,
  );
  assert.equal(exactDraft.statusCode, 200);
  assert.equal(exactDraft.json.entries.length, 1);
  assert.equal(exactDraft.json.entries[0].status, 'draft');
  assert.equal(exactDraft.json.entries[0].occurred_timezone, 'Europe/Zurich');

  const finalPayload = {
    ...draftPayload(),
    status: 'final',
    note: 'Task 14 final',
  };
  const final = await request(
    baseUrl,
    'PUT',
    `/api/journal/entries/${CANONICAL_IDS.draftEntryUuid}`,
    finalPayload,
  );
  assert.equal(final.statusCode, 200);
  assert.equal(final.json.entry_uuid, CANONICAL_IDS.draftEntryUuid);
  assert.equal(final.json.sync_version, 1);
  assert.match(final.json.outbox_event_uuid, /^[0-9a-f-]{36}$/);

  const exactFinal = await request(
    baseUrl,
    'GET',
    `/api/journal/entries?entry_uuid=${CANONICAL_IDS.draftEntryUuid}&status=all&limit=1`,
  );
  assert.equal(exactFinal.statusCode, 200);
  assert.equal(exactFinal.json.entries[0].status, 'final');
  assert.equal(exactFinal.json.entries[0].note, 'Task 14 final');

  const status = await request(baseUrl, 'GET', '/__task14/status');
  assert.equal(status.statusCode, 200);
  assert.equal(status.json.draft_post_count, 1);
  assert.equal(status.json.final_put_count, 1);
  assert.deepEqual(status.json.last_final_payload, finalPayload);

  const unknown = await request(baseUrl, 'GET', '/api/not-a-real-preview-route');
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json.error, 'unknown_preview_route');

  const traversal = await request(baseUrl, 'GET', '/gui/%2e%2e/AGENTS.md');
  assert.notEqual(traversal.statusCode, 200);
  assert.doesNotMatch(traversal.text, /Operational source of truth/);
});

test('aggregate payload timestamps use supplied start and end UTC offsets', async (t) => {
  const preview = createTask14JournalPreviewServer();
  await preview.listen();
  t.after(() => preview.close());
  const baseUrl = preview.url();

  const payload = {
    ...draftPayload(),
    occurred_start_local: '2026-07-16T07:30:15.123',
    occurred_utc_offset_minutes: 330,
    occurred_end_local: '2026-07-16T08:45:16.789',
    occurred_end_utc_offset_minutes: -90,
  };
  const created = await request(baseUrl, 'POST', '/api/journal/entries', payload);
  assert.equal(created.statusCode, 201);

  const stored = await request(
    baseUrl,
    'GET',
    `/api/journal/entries?entry_uuid=${CANONICAL_IDS.draftEntryUuid}&status=all&limit=1`,
  );
  assert.equal(stored.statusCode, 200);
  assert.equal(stored.json.entries.length, 1);
  assert.equal(stored.json.entries[0].occurred_start, '2026-07-16T02:00:15.123Z');
  assert.equal(stored.json.entries[0].occurred_end, '2026-07-16T10:15:16.789Z');
  assert.match(stored.json.entries[0].occurred_start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(stored.json.entries[0].occurred_end, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('journal entry occurred bounds are inclusive, instant-based, and fail closed when malformed', async (t) => {
  const preview = createTask14JournalPreviewServer();
  await preview.listen();
  t.after(() => preview.close());
  const baseUrl = preview.url();
  const seededInstant = '2026-07-15T05:30:00.000Z';

  const inWindow = await request(
    baseUrl,
    'GET',
    '/api/journal/entries?occurred_from=2026-07-15T04:00:00.000Z&occurred_to=2026-07-15T06:00:00.000Z',
  );
  assert.equal(inWindow.statusCode, 200);
  assert.deepEqual(inWindow.json.entries.map((entry) => entry.entry_uuid), [CANONICAL_IDS.finalEntryUuid]);

  const boundary = await request(
    baseUrl,
    'GET',
    `/api/journal/entries?occurred_from=${seededInstant}&occurred_to=${seededInstant}`,
  );
  assert.equal(boundary.statusCode, 200);
  assert.deepEqual(boundary.json.entries.map((entry) => entry.entry_uuid), [CANONICAL_IDS.finalEntryUuid]);

  const afterSeededEntry = await request(
    baseUrl,
    'GET',
    '/api/journal/entries?occurred_from=2026-07-16T05:00:00.000Z&occurred_to=2026-07-16T06:00:00.000Z',
  );
  assert.equal(afterSeededEntry.statusCode, 200);
  assert.deepEqual(afterSeededEntry.json.entries, [], 'prior-day entry must not become a duplicate candidate');

  const beforeSeededEntry = await request(
    baseUrl,
    'GET',
    '/api/journal/entries?occurred_from=2026-07-15T04:00:00.000Z&occurred_to=2026-07-15T05:29:59.999Z',
  );
  assert.equal(beforeSeededEntry.statusCode, 200);
  assert.deepEqual(beforeSeededEntry.json.entries, []);

  const malformedFrom = await request(
    baseUrl,
    'GET',
    '/api/journal/entries?occurred_from=not-an-instant',
  );
  assert.equal(malformedFrom.statusCode, 400);
  assert.equal(malformedFrom.json.error, 'invalid_filter');

  const malformedTo = await request(
    baseUrl,
    'GET',
    '/api/journal/entries?occurred_to=2026-99-99T99:99:99.000Z',
  );
  assert.equal(malformedTo.statusCode, 400);
  assert.equal(malformedTo.json.error, 'invalid_filter');
});

test('preview API and status require the injected demo bearer token and known routes reject wrong methods', async (t) => {
  const preview = createTask14JournalPreviewServer();
  await preview.listen();
  t.after(() => preview.close());
  const baseUrl = preview.url();

  const zones = await request(baseUrl, 'GET', '/api/irrigation-zones', undefined, {
    authenticated: false,
  });
  assert.equal(zones.statusCode, 401);
  assert.equal(zones.json.error, 'unauthorized');

  const create = await request(baseUrl, 'POST', '/api/journal/entries', draftPayload(), {
    authenticated: false,
  });
  assert.equal(create.statusCode, 401);

  const status = await request(baseUrl, 'GET', '/__task14/status', undefined, {
    authenticated: false,
  });
  assert.equal(status.statusCode, 401);

  const wrongMethod = await request(baseUrl, 'POST', '/api/journal/catalog', {});
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.json.error, 'method_not_allowed');

  const healthy = await request(baseUrl, 'GET', '/api/irrigation-zones');
  assert.equal(healthy.statusCode, 200);
});

test('preview body parsing fails closed without crashing or retaining oversized input', async (t) => {
  const preview = createTask14JournalPreviewServer();
  await preview.listen();
  t.after(() => preview.close());
  const baseUrl = preview.url();

  const malformed = await request(baseUrl, 'POST', '/api/journal/entries', undefined, {
    rawBody: '{"status":',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json.error, 'invalid_json');

  const oversized = await request(baseUrl, 'POST', '/api/journal/entries', undefined, {
    rawBody: JSON.stringify({ note: 'x'.repeat(256 * 1024 + 1) }),
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json.error, 'body_too_large');

  const healthy = await request(baseUrl, 'GET', '/api/irrigation-zones');
  assert.equal(healthy.statusCode, 200);
});

test('preview entry filters reject invalid status, limit, UUID, and cursor inputs', async (t) => {
  const preview = createTask14JournalPreviewServer();
  await preview.listen();
  t.after(() => preview.close());
  const baseUrl = preview.url();

  const cases = [
    ['/api/journal/entries?status=bogus', 'invalid_filter'],
    ['/api/journal/entries?limit=0', 'invalid_limit'],
    ['/api/journal/entries?entry_uuid=not-a-uuid', 'invalid_filter'],
    ['/api/journal/entries?cursor=not-a-cursor', 'invalid_cursor'],
  ];
  for (const [path, error] of cases) {
    const response = await request(baseUrl, 'GET', path);
    assert.equal(response.statusCode, 400, path);
    assert.equal(response.json.error, error, path);
  }

  const compactUuid = CANONICAL_IDS.finalEntryUuid.replaceAll('-', '');
  const canonicalized = await request(
    baseUrl,
    'GET',
    `/api/journal/entries?entry_uuid=${compactUuid}&status=all`,
  );
  assert.equal(canonicalized.statusCode, 200);
  assert.deepEqual(
    canonicalized.json.entries.map((entry) => entry.entry_uuid),
    [CANONICAL_IDS.finalEntryUuid],
  );
});

test('preview finalization applies the real edge choice validator', async (t) => {
  const preview = createTask14JournalPreviewServer();
  await preview.listen();
  t.after(() => preview.close());
  const baseUrl = preview.url();

  const created = await request(baseUrl, 'POST', '/api/journal/entries', draftPayload());
  assert.equal(created.statusCode, 201);

  const invalid = await request(
    baseUrl,
    'PUT',
    `/api/journal/entries/${CANONICAL_IDS.draftEntryUuid}`,
    {
      ...draftPayload(),
      status: 'final',
      values: [{
        attribute_code: 'attr.crop',
        value_status: 'observed',
        value: 'Barley',
      }],
    },
  );
  assert.equal(invalid.statusCode, 422);
  assert.equal(invalid.json.error, 'invalid_entry_payload');
  assert.ok(invalid.json.errors.some((error) => error.code === 'invalid_choice'));

  const valid = await request(
    baseUrl,
    'PUT',
    `/api/journal/entries/${CANONICAL_IDS.draftEntryUuid}`,
    { ...draftPayload(), status: 'final' },
  );
  assert.equal(valid.statusCode, 200);
});
