#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const edgeJournal = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal'
);

const repoRoot = path.resolve(__dirname, '..');
const defaultBuildDir = path.join(repoRoot, 'web/react-gui/build');

const CANONICAL_IDS = Object.freeze({
  userUuid: '11111111-1111-4111-8111-111111111111',
  zoneUuid: '22222222-2222-4222-8222-222222222222',
  plotUuid: '33333333-3333-4333-8333-333333333333',
  draftEntryUuid: '44444444-4444-4444-8444-444444444444',
  finalEntryUuid: '55555555-5555-4555-8555-555555555555',
  seasonUuid: '66666666-6666-4666-8666-666666666666',
  gatewayEui: '0011223344556677',
  numericPlotUuid: '88888888-8888-4888-8888-888888888888',
  namedPlotUuid: '99999999-9999-4999-8999-999999999999',
  activeGroupUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resolvedGroupUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
});

const DEMO_AUTH_TOKEN = 'task14-demo-token';
const DEMO_USERNAME = 'demo';
const FIXTURE_TIME = '2026-07-16T05:30:00.000Z';
const LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

function parseJson(value, fallback) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToObject(row) {
  return {
    table: row.table,
    ...Object.fromEntries(row.columns.map((column, index) => [column, row.values[index]])),
  };
}

function buildCatalog() {
  const core = require('./journal-catalog-core');
  const source = require('../docs/superpowers/specs/agroscope-open-field/catalog.json');
  const generator = require('./generate-journal-catalog');
  const compiled = generator.compileCatalog(core, source);
  const rows = compiled.rows.map(rowToObject);

  const vocab = rows.filter((row) => row.table === 'journal_vocab')
    .map((row) => ({
      code: row.code,
      kind: row.kind,
      parent_code: row.parent_code ?? null,
      value_type: row.value_type ?? null,
      quantity_kind: row.quantity_kind ?? null,
      basis: row.basis ?? null,
      default_unit_code: row.default_unit_code ?? null,
      icon_key: row.icon_key ?? null,
      scope: row.scope,
      owner_user_uuid: null,
      gateway_device_eui: null,
      custom_field_uuid: null,
      active: Number(row.active),
      sort_order: Number(row.sort_order),
      sync_version: Number(row.sync_version),
      created_at: row.created_at,
      deleted_at: null,
      catalog_errors: [],
      labels: parseJson(row.labels_json, {}),
      constraints: parseJson(row.constraints_json, null),
    }));

  const definitions = (table) => rows.filter((row) => row.table === `journal_${table}`)
    .map((row) => ({
      code: row.code,
      version: Number(row.version),
      active: Number(row.active),
      catalog_errors: [],
      labels: parseJson(row.labels_json, {}),
      definition: parseJson(row.definition_json, {}),
    }));

  const products = rows.filter((row) => row.table === 'journal_products').map((row) => ({
    product_uuid: row.product_uuid,
    scope: row.scope,
    owner_user_uuid: null,
    gateway_device_eui: null,
    name: row.name,
    kind: row.kind,
    active: Number(row.active),
    sync_version: Number(row.sync_version),
    created_at: row.created_at,
    deleted_at: null,
    catalog_errors: [],
    composition: parseJson(row.composition_json, {}),
  }));

  const mappings = rows.filter((row) => row.table === 'journal_vocab_mappings').map((row) => ({
    term_code: row.term_code,
    scheme_uri: row.scheme_uri,
    scheme_version: row.scheme_version,
    mapping_role: row.mapping_role,
    external_id: row.external_id,
    external_parent_id: row.external_parent_id ?? null,
    mapping_relation: row.mapping_relation,
    source_uri: row.source_uri ?? null,
    active: Number(row.active),
  }));

  return {
    catalog_version: 1,
    catalog_hash: compiled.catalogHash,
    vocab,
    templates: definitions('templates'),
    layouts: definitions('layouts'),
    products,
    mappings,
  };
}

function irrigationZone() {
  return {
    id: 14,
    name: 'Demo South Orchard',
    device_count: 1,
    deviceCount: 1,
    created_at: '2026-01-10T08:00:00.000Z',
    createdAt: '2026-01-10T08:00:00.000Z',
    updated_at: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    zone_uuid: CANONICAL_IDS.zoneUuid,
    zoneUuid: CANONICAL_IDS.zoneUuid,
    timezone: 'Europe/Zurich',
    latitude: 47.3769,
    longitude: 8.5417,
    gateway_device_eui: CANONICAL_IDS.gatewayEui,
    gatewayDeviceEui: CANONICAL_IDS.gatewayEui,
    phenological_stage: 'fruit_development',
    crop_type: 'barley, winter',
    cropType: 'barley, winter',
    variety: 'Gala',
    soil_type: 'loam',
    irrigation_method: 'drip',
    area_m2: 1200,
    irrigation_efficiency_pct: 90,
    measured_flow_rate_lpm: 42,
    measurement_method: 'flow_meter',
    irrigation_calibration_updated_at: '2026-06-01T08:00:00.000Z',
    scheduling_mode: 'local',
    notes: null,
    calibration_key: null,
    prediction_card_enabled: false,
    schedule: {
      irrigation_zone_id: 14,
      trigger_metric: 'SWT_WM1',
      triggerMetric: 'SWT_WM1',
      threshold_kpa: 35,
      thresholdKpa: 35,
      enabled: false,
      duration_minutes: 20,
      durationMinutes: 20,
      last_triggered_at: null,
      lastTriggeredAt: null,
      response_mode: 'proportional',
      responseMode: 'proportional',
    },
  };
}

function plot() {
  return {
    contract_version: 1,
    plot_uuid: CANONICAL_IDS.plotUuid,
    plot_code: 'SOUTH-ORCHARD',
    name: 'South Orchard',
    zone_uuid: CANONICAL_IDS.zoneUuid,
    station_code: 'SOUTH-01',
    crop_hint: 'barley, winter',
    area_m2: 1200,
    active: 1,
    sync_version: 3,
    owner_user_uuid: CANONICAL_IDS.userUuid,
    gateway_device_eui: CANONICAL_IDS.gatewayEui,
    created_at: '2026-01-10T08:00:00.000Z',
    updated_at: FIXTURE_TIME,
    deleted_at: null,
    settings: {
      layout_code: 'open_field',
      updated_at: FIXTURE_TIME,
      updated_by_principal_uuid: CANONICAL_IDS.userUuid,
      sync_version: 3,
    },
  };
}

function numberedPlot() {
  return {
    ...plot(),
    plot_uuid: CANONICAL_IDS.numericPlotUuid,
    plot_code: '2',
    name: 'South 2',
    sync_version: 1,
    settings: { ...plot().settings, sync_version: 1 },
  };
}

function namedPlot() {
  return {
    ...plot(),
    plot_uuid: CANONICAL_IDS.namedPlotUuid,
    plot_code: 'SOUTH-A',
    name: 'South named',
    station_code: 'SOUTH-01',
    sync_version: 1,
    settings: { ...plot().settings, sync_version: 1 },
  };
}

function plotGroup(groupUuid, members, resolved) {
  return {
    contract_version: 1,
    group_uuid: groupUuid,
    label: resolved ? 'Resolved south' : 'Active south',
    owner_user_uuid: CANONICAL_IDS.userUuid,
    gateway_device_eui: CANONICAL_IDS.gatewayEui,
    created_by_principal_uuid: CANONICAL_IDS.userUuid,
    created_at: '2026-01-10T08:00:00.000Z',
    resolved_at: resolved ? '2026-07-17T08:30:00.000Z' : null,
    resolved_by_principal_uuid: resolved ? CANONICAL_IDS.userUuid : null,
    sync_version: 1,
    deleted_at: null,
    members: [...members].sort(),
  };
}

function aggregateValue(input) {
  const value = input || {};
  const raw = value.value;
  const numeric = value.value_num ?? (typeof raw === 'number' ? raw : null);
  const text = value.value_text ?? (typeof raw === 'string' ? raw : null);
  return {
    group_index: Number(value.group_index ?? 0),
    attribute_code: String(value.attribute_code),
    value_status: value.value_status || 'observed',
    value_num: numeric,
    value_text: text,
    unit_code: value.unit_code ?? null,
    entered_value_num: value.entered_value_num ?? numeric,
    entered_unit_code: value.entered_unit_code ?? value.unit_code ?? null,
  };
}

function canonicalLocalTimestamp(raw, offsetMinutes, field) {
  const match = typeof raw === 'string' ? LOCAL_TIMESTAMP.exec(raw) : null;
  if (!match) throw new Error(`invalid_${field}`);

  const offset = Number(offsetMinutes);
  if (!Number.isInteger(offset) || Math.abs(offset) > 18 * 60) {
    throw new Error(`invalid_${field}_offset`);
  }

  const local = raw.length === 16 ? `${raw}:00` : raw;
  const absoluteOffset = Math.abs(offset);
  const sign = offset < 0 ? '-' : '+';
  const offsetText = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}:` +
    `${String(absoluteOffset % 60).padStart(2, '0')}`;
  const instant = new Date(`${local}${offsetText}`);
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid_${field}`);
  return instant.toISOString();
}

function aggregateFromPayload(payload, status, entryUuid, catalogVersion) {
  const occurredStartLocal = payload.occurred_start_local || '2026-07-16T07:30';
  const occurredStartOffset = Number(payload.occurred_utc_offset_minutes ?? 120);
  const occurredStart = canonicalLocalTimestamp(
    occurredStartLocal,
    occurredStartOffset,
    'occurred_start',
  );
  const occurredEnd = payload.occurred_end_local == null
    ? null
    : canonicalLocalTimestamp(
      payload.occurred_end_local,
      payload.occurred_end_utc_offset_minutes ?? occurredStartOffset,
      'occurred_end',
    );
  const values = (Array.isArray(payload.values) ? payload.values : []).map(aggregateValue);
  return {
    contract_version: 1,
    entry_uuid: entryUuid,
    owner_user_uuid: CANONICAL_IDS.userUuid,
    author_principal_uuid: CANONICAL_IDS.userUuid,
    author_label: DEMO_USERNAME,
    gateway_device_eui: CANONICAL_IDS.gatewayEui,
    plot_uuid: payload.plot_uuid ?? CANONICAL_IDS.plotUuid,
    zone_uuid: payload.zone_uuid ?? CANONICAL_IDS.zoneUuid,
    device_eui: payload.device_eui ?? null,
    season_uuid: CANONICAL_IDS.seasonUuid,
    season_crop: payload.season_crop ?? 'barley, winter',
    season_variety: payload.season_variety ?? 'Gala',
    campaign_uuid: payload.campaign_uuid ?? null,
    protocol_code: payload.protocol_code ?? null,
    protocol_version: payload.protocol_version ?? null,
    observation_unit_code: payload.observation_unit_code ?? null,
    activity_code: payload.activity_code || 'irrigation',
    template_code: payload.template_code || 'farmer_quick',
    template_version: Number(payload.template_version || 1),
    layout_code: payload.layout_code || 'open_field',
    layout_version: Number(payload.layout_version || 1),
    catalog_version: catalogVersion,
    occurred_start: occurredStart,
    occurred_end: occurredEnd,
    occurred_timezone: payload.occurred_timezone || 'Europe/Zurich',
    occurred_utc_offset_minutes: occurredStartOffset,
    origin: 'edge-ui',
    status,
    batch_uuid: payload.batch_uuid ?? null,
    pass_uuid: payload.pass_uuid ?? null,
    voided_at: null,
    voided_by_principal_uuid: null,
    void_reason: null,
    note: payload.note ?? null,
    context_json: JSON.stringify({ values }),
    sync_version: status === 'final' ? 1 : 0,
    recorded_at: FIXTURE_TIME,
    created_at: FIXTURE_TIME,
    updated_at: FIXTURE_TIME,
    deleted_at: null,
    values,
  };
}

function seededFinalEntry(catalogVersion) {
  return aggregateFromPayload({
    plot_uuid: CANONICAL_IDS.plotUuid,
    zone_uuid: CANONICAL_IDS.zoneUuid,
    season_crop: 'barley, winter',
    season_variety: 'Gala',
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-15T07:30',
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    values: [
      {
        attribute_code: 'attr.crop',
        value_status: 'observed',
        value_text: 'agroscope.crop.barley_winter',
        value: 'agroscope.crop.barley_winter',
      },
      { attribute_code: 'attr.irrigation_depth', value_status: 'observed', value_num: 10, unit_code: 'unit.mm_water' },
    ],
    note: 'Previous irrigation',
  }, 'final', CANONICAL_IDS.finalEntryUuid, catalogVersion);
}

function createState(catalog) {
  return {
    catalog,
    edgeCatalog: {
      vocabByCode: new Map(catalog.vocab.map((row) => [row.code, row])),
      products: new Map(catalog.products.map((row) => [row.product_uuid, row])),
      templates: new Map(catalog.templates.map((row) => [row.code, row])),
      layouts: new Map(catalog.layouts.map((row) => [row.code, row])),
    },
    zones: [irrigationZone()],
    plots: [plot(), numberedPlot(), namedPlot()],
    plotGroups: [
      plotGroup(CANONICAL_IDS.activeGroupUuid, [CANONICAL_IDS.plotUuid, CANONICAL_IDS.numericPlotUuid], false),
      plotGroup(CANONICAL_IDS.resolvedGroupUuid, [CANONICAL_IDS.plotUuid], true),
    ],
    entries: new Map([[CANONICAL_IDS.finalEntryUuid, seededFinalEntry(catalog.catalog_version)]]),
    draftPostCount: 0,
    finalPutCount: 0,
    plotPostCount: 0,
    plotPutCount: 0,
    groupPostCount: 0,
    groupPutCount: 0,
    batchPostCount: 0,
    lastFinalPayload: null,
    lastBatchPayload: null,
  };
}

function plotFromPayload(payload, syncVersion) {
  const base = plot();
  return {
    contract_version: 1,
    plot_uuid: payload.plot_uuid,
    plot_code: payload.plot_code,
    name: payload.name ?? null,
    zone_uuid: payload.zone_uuid ?? null,
    station_code: payload.station_code ?? null,
    crop_hint: payload.crop_hint ?? null,
    area_m2: payload.area_m2 ?? null,
    active: payload.active,
    sync_version: syncVersion,
    owner_user_uuid: base.owner_user_uuid,
    gateway_device_eui: base.gateway_device_eui,
    created_at: base.created_at,
    updated_at: FIXTURE_TIME,
    deleted_at: null,
    settings: {
      layout_code: payload.layout_code,
      updated_at: FIXTURE_TIME,
      updated_by_principal_uuid: CANONICAL_IDS.userUuid,
      sync_version: syncVersion,
    },
  };
}

function groupFromPayload(payload, syncVersion) {
  const base = plotGroup(payload.group_uuid, payload.members, payload.resolved);
  return {
    contract_version: 1,
    group_uuid: payload.group_uuid,
    label: payload.label,
    owner_user_uuid: base.owner_user_uuid,
    gateway_device_eui: base.gateway_device_eui,
    created_by_principal_uuid: base.created_by_principal_uuid,
    created_at: base.created_at,
    resolved_at: payload.resolved ? '2026-07-17T08:30:00.000Z' : null,
    resolved_by_principal_uuid: payload.resolved ? CANONICAL_IDS.userUuid : null,
    sync_version: syncVersion,
    deleted_at: null,
    members: [...payload.members].sort(),
  };
}

function validateEntryPayload(state, payload) {
  const layout = state.catalog.layouts.find((row) =>
    row.code === payload.layout_code && Number(row.version) === Number(payload.layout_version));
  const template = state.catalog.templates.find((row) =>
    row.code === payload.template_code && Number(row.version) === Number(payload.template_version));
  return edgeJournal.validateEntry(state.edgeCatalog, layout, template, payload);
}

function json(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function errorJson(res, statusCode, error) {
  json(res, statusCode, { error });
}

function hasDemoAuthorization(req) {
  return req.headers.authorization === `Bearer ${DEMO_AUTH_TOKEN}`;
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
  }[extension] || 'application/octet-stream';
}

function injectedIndex(index) {
  const bootstrap = `<script>localStorage.setItem('auth_token', '${DEMO_AUTH_TOKEN}');localStorage.setItem('username', '${DEMO_USERNAME}');</script>`;
  const marker = '<script type="module"';
  const markerIndex = index.indexOf(marker);
  return markerIndex === -1
    ? index.replace('</head>', `${bootstrap}</head>`)
    : `${index.slice(0, markerIndex)}${bootstrap}${index.slice(markerIndex)}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 256 * 1024) {
        tooLarge = true;
        body = '';
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('body_too_large'));
        return;
      }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function parseOccurredBound(query, field) {
  const raw = query.get(field);
  if (raw == null || raw === '') return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

const PREVIEW_UUID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

function canonicalPreviewUuid(value) {
  const compact = value.replaceAll('-', '').toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-` +
    `${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function validatedEntryQuery(query) {
  const status = (query.get('status') || 'final').trim().toLowerCase();
  if (!['draft', 'final', 'voided', 'all'].includes(status)) {
    return { error: 'invalid_filter' };
  }
  const rawLimit = query.get('limit');
  const limit = rawLimit == null || rawLimit === '' ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) return { error: 'invalid_limit' };
  for (const field of ['entry_uuid', 'plot_uuid', 'zone_uuid', 'campaign_uuid', 'batch_uuid', 'pass_uuid']) {
    const value = query.get(field);
    if (value != null && value !== '' && !PREVIEW_UUID.test(value)) return { error: 'invalid_filter' };
    if (value) query.set(field, canonicalPreviewUuid(value));
  }
  if (query.get('cursor')) return { error: 'invalid_cursor' };
  const occurredBounds = {
    from: parseOccurredBound(query, 'occurred_from'),
    to: parseOccurredBound(query, 'occurred_to'),
  };
  if (Number.isNaN(occurredBounds.from) || Number.isNaN(occurredBounds.to)) {
    return { error: 'invalid_filter' };
  }
  return { status, limit: Math.min(limit, 100), occurredBounds };
}

function filteredEntries(state, query, requestedStatus, occurredBounds, limit) {
  const entries = [...state.entries.values()].filter((entry) => {
    if (requestedStatus !== 'all' && entry.status !== requestedStatus) return false;
    if (query.get('entry_uuid') && entry.entry_uuid !== query.get('entry_uuid')) return false;
    if (query.get('plot_uuid') && entry.plot_uuid !== query.get('plot_uuid')) return false;
    if (query.get('zone_uuid') && entry.zone_uuid !== query.get('zone_uuid')) return false;
    if (query.get('activity_code') && entry.activity_code !== query.get('activity_code')) return false;
    const occurredAt = Date.parse(entry.occurred_start);
    if (!Number.isFinite(occurredAt)) return false;
    if (occurredBounds.from != null && occurredAt < occurredBounds.from) return false;
    if (occurredBounds.to != null && occurredAt > occurredBounds.to) return false;
    return true;
  });
  entries.sort((left, right) => right.occurred_start.localeCompare(left.occurred_start));
  return entries.slice(0, limit);
}

async function handleApi(req, res, requestUrl, state) {
  const requestPath = requestUrl.pathname;
  const query = requestUrl.searchParams;

  const updateMatch = /^\/api\/journal\/entries\/([^/]+)$/.exec(requestPath);
  const plotUpdateMatch = /^\/api\/journal\/plots\/([^/]+)$/.exec(requestPath);
  const groupUpdateMatch = /^\/api\/journal\/plot-groups\/([^/]+)$/.exec(requestPath);
  const allowedMethods = requestPath === '/api/irrigation-zones' ||
      requestPath === '/api/journal/catalog'
    ? ['GET']
    : requestPath === '/api/journal/plots' || requestPath === '/api/journal/plot-groups'
      ? ['GET', 'POST']
    : requestPath === '/api/journal/entries'
      ? ['GET', 'POST']
      : plotUpdateMatch || groupUpdateMatch || updateMatch ? ['PUT'] : null;
  if (allowedMethods && !allowedMethods.includes(req.method)) {
    return errorJson(res, 405, 'method_not_allowed');
  }

  if (req.method === 'GET' && requestPath === '/api/irrigation-zones') return json(res, 200, state.zones);
  if (req.method === 'GET' && requestPath === '/api/journal/catalog') return json(res, 200, state.catalog);
  if (req.method === 'GET' && requestPath === '/api/journal/plots') return json(res, 200, { plots: state.plots });
  if (req.method === 'GET' && requestPath === '/api/journal/plot-groups') return json(res, 200, { plot_groups: state.plotGroups });

  if (req.method === 'POST' && requestPath === '/api/journal/plots') {
    const payload = await readBody(req);
    if (payload.base_sync_version !== 0 || !PREVIEW_UUID.test(payload.plot_uuid) ||
        state.plots.some((candidate) => candidate.plot_uuid === payload.plot_uuid)) {
      return errorJson(res, 409, 'stale_version');
    }
    const created = plotFromPayload(payload, 1);
    state.plots.push(created);
    state.plotPostCount += 1;
    return json(res, 201, { plot: created });
  }

  if (req.method === 'PUT' && plotUpdateMatch) {
    const plotUuid = decodeURIComponent(plotUpdateMatch[1]);
    const current = state.plots.find((candidate) => candidate.plot_uuid === plotUuid);
    const payload = await readBody(req);
    if (!current || payload.plot_uuid !== plotUuid || payload.base_sync_version !== current.sync_version) {
      return json(res, 409, { error: 'stale_version', message: 'Plot version is stale', details: null });
    }
    const updated = plotFromPayload(payload, current.sync_version + 1);
    state.plots = state.plots.map((candidate) => candidate.plot_uuid === plotUuid ? updated : candidate);
    state.plotPutCount += 1;
    return json(res, 200, { plot: updated });
  }

  if (req.method === 'POST' && requestPath === '/api/journal/plot-groups') {
    const payload = await readBody(req);
    if (payload.base_sync_version !== 0 || !PREVIEW_UUID.test(payload.group_uuid) ||
        payload.resolved !== false || state.plotGroups.some((candidate) => candidate.group_uuid === payload.group_uuid)) {
      return errorJson(res, 409, 'stale_version');
    }
    const created = groupFromPayload(payload, 1);
    state.plotGroups.push(created);
    state.groupPostCount += 1;
    return json(res, 201, { plot_group: created });
  }

  if (req.method === 'PUT' && groupUpdateMatch) {
    const groupUuid = decodeURIComponent(groupUpdateMatch[1]);
    const current = state.plotGroups.find((candidate) => candidate.group_uuid === groupUuid);
    const payload = await readBody(req);
    if (!current || payload.group_uuid !== groupUuid || typeof payload.resolved !== 'boolean' ||
        payload.base_sync_version !== current.sync_version) {
      return json(res, 409, { error: 'stale_version', message: 'Plot-group version is stale', details: null });
    }
    const updated = groupFromPayload(payload, current.sync_version + 1);
    state.plotGroups = state.plotGroups.map((candidate) => candidate.group_uuid === groupUuid ? updated : candidate);
    state.groupPutCount += 1;
    return json(res, 200, { plot_group: updated });
  }
  if (req.method === 'GET' && requestPath === '/api/journal/entries') {
    const validated = validatedEntryQuery(query);
    if (validated.error) return errorJson(res, 400, validated.error);
    return json(res, 200, {
      entries: filteredEntries(
        state,
        query,
        validated.status,
        validated.occurredBounds,
        validated.limit,
      ),
      next_cursor: null,
    });
  }

  if (req.method === 'POST' && requestPath === '/api/journal/entries') {
    const payload = await readBody(req);
    if (Array.isArray(payload.plot_uuids)) {
      state.batchPostCount += 1;
      if (payload.status !== 'final' || payload.plot_uuids.length === 0 || payload.plot_uuids.length > 100 ||
          new Set(payload.plot_uuids).size !== payload.plot_uuids.length ||
          Object.prototype.hasOwnProperty.call(payload, 'plot_uuid') ||
          Object.prototype.hasOwnProperty.call(payload, 'zone_uuid')) {
        return errorJson(res, 400, 'invalid_batch_payload');
      }
      const validation = validateEntryPayload(state, {
        ...payload,
        plot_uuid: payload.plot_uuids[0],
        zone_uuid: null,
      });
      if (!validation.ok) return json(res, 422, { error: 'invalid_entry_payload', errors: validation.errors });

      const duplicateCandidates = payload.plot_uuids.map((plotUuid, index) => ({
        entryUuid: `eeeeeeee-eeee-4eee-8eee-${String(index + 1).padStart(12, '0')}`,
        occurredStart: FIXTURE_TIME,
        activityCode: payload.activity_code,
        plotUuid,
      }));
      const acknowledgements = Array.isArray(payload.duplicate_guard_ack_entry_uuids)
        ? payload.duplicate_guard_ack_entry_uuids
        : [];
      if (!duplicateCandidates.every((candidate) => acknowledgements.includes(candidate.entryUuid))) {
        return json(res, 409, { error: 'duplicate_candidates', details: { duplicateCandidates } });
      }

      const batchUuid = `ffffffff-ffff-4fff-8fff-${String(state.batchPostCount).padStart(12, '0')}`;
      const receipts = payload.plot_uuids.map((plotUuid, index) => {
        const entryUuid = duplicateCandidates[index].entryUuid;
        const plotRecord = state.plots.find((candidate) => candidate.plot_uuid === plotUuid);
        const entry = aggregateFromPayload({
          ...payload,
          plot_uuid: plotUuid,
          zone_uuid: plotRecord?.zone_uuid ?? null,
          batch_uuid: batchUuid,
        }, 'final', entryUuid, state.catalog.catalog_version);
        state.entries.set(entryUuid, entry);
        return {
          plot_uuid: plotUuid,
          entry_uuid: entryUuid,
          outbox_event_uuid: `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, '0')}`,
          sync_version: 1,
        };
      });
      state.lastBatchPayload = payload;
      return json(res, 201, { batch_uuid: batchUuid, entries: receipts });
    }
    if (payload.status !== 'draft' || typeof payload.entry_uuid !== 'string') return errorJson(res, 400, 'invalid_draft_payload');
    const validation = validateEntryPayload(state, payload);
    if (!validation.ok) return json(res, 422, { error: 'invalid_entry_payload', errors: validation.errors });
    const entry = aggregateFromPayload(payload, 'draft', payload.entry_uuid, state.catalog.catalog_version);
    state.entries.set(entry.entry_uuid, entry);
    state.draftPostCount += 1;
    return json(res, 201, { entry_uuid: entry.entry_uuid, sync_version: 0 });
  }

  if (req.method === 'PUT' && updateMatch) {
    const entryUuid = decodeURIComponent(updateMatch[1]);
    const payload = await readBody(req);
    if (payload.status !== 'final' || !state.entries.has(entryUuid)) return errorJson(res, 400, 'invalid_final_payload');
    const validation = validateEntryPayload(state, payload);
    if (!validation.ok) return json(res, 422, { error: 'invalid_entry_payload', errors: validation.errors });
    const entry = aggregateFromPayload(payload, 'final', entryUuid, state.catalog.catalog_version);
    state.entries.set(entryUuid, entry);
    state.finalPutCount += 1;
    state.lastFinalPayload = payload;
    return json(res, 200, {
      entry_uuid: entryUuid,
      outbox_event_uuid: '77777777-7777-4777-8777-777777777777',
      sync_version: 1,
    });
  }

  return errorJson(res, 404, 'unknown_preview_route');
}

function serveStatic(req, res, requestUrl, buildDir, index) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return errorJson(res, 405, 'method_not_allowed');
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestUrl.pathname);
  } catch {
    return errorJson(res, 400, 'invalid_path');
  }
  if (!decodedPath.startsWith('/gui')) return errorJson(res, 404, 'not_found');
  const relative = decodedPath === '/gui' || decodedPath === '/gui/' ? '' : decodedPath.slice('/gui/'.length);
  if (relative.split('/').includes('..') || decodedPath.includes('\0')) return errorJson(res, 403, 'path_traversal_rejected');

  const candidate = path.resolve(buildDir, relative);
  const relativeToBuild = path.relative(buildDir, candidate);
  if (relativeToBuild.startsWith('..') || path.isAbsolute(relativeToBuild)) return errorJson(res, 403, 'path_traversal_rejected');

  if (!relative || !relativeToBuild) {
    const body = Buffer.from(index);
    res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
    return req.method === 'HEAD' ? res.end() : res.end(body);
  }

  let filePath = candidate;
  try {
    if (!fs.statSync(filePath).isFile()) throw new Error('not_file');
  } catch {
    if (relative.startsWith('assets/')) return errorJson(res, 404, 'not_found');
    const body = Buffer.from(index);
    res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
    return req.method === 'HEAD' ? res.end() : res.end(body);
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': contentType(filePath), 'Content-Length': body.length });
  return req.method === 'HEAD' ? res.end() : res.end(body);
}

function createTask14JournalPreviewServer(options = {}) {
  const buildDir = path.resolve(options.buildDir || defaultBuildDir);
  const indexPath = path.join(buildDir, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error(`Built GUI index not found: ${indexPath}`);
  const state = createState(buildCatalog());
  const index = injectedIndex(fs.readFileSync(indexPath, 'utf8'));

  const server = http.createServer(async (req, res) => {
    let requestUrl;
    try {
      requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      return errorJson(res, 400, 'invalid_request_url');
    }
    try {
      if ((requestUrl.pathname === '/__task14/status' || requestUrl.pathname.startsWith('/api/')) &&
          !hasDemoAuthorization(req)) {
        return errorJson(res, 401, 'unauthorized');
      }
      if (requestUrl.pathname === '/__task14/status') {
        if (req.method !== 'GET') return errorJson(res, 405, 'method_not_allowed');
        return json(res, 200, {
          draft_post_count: state.draftPostCount,
          final_put_count: state.finalPutCount,
          plot_post_count: state.plotPostCount,
          plot_put_count: state.plotPutCount,
          group_post_count: state.groupPostCount,
          group_put_count: state.groupPutCount,
          batch_post_count: state.batchPostCount,
          last_final_payload: state.lastFinalPayload,
          last_batch_payload: state.lastBatchPayload,
        });
      }
      if (requestUrl.pathname.startsWith('/api/')) return await handleApi(req, res, requestUrl, state);
      if (requestUrl.pathname === '/gui' || requestUrl.pathname.startsWith('/gui/')) {
        return serveStatic(req, res, requestUrl, buildDir, index);
      }
      return errorJson(res, 404, 'not_found');
    } catch (error) {
      if (error && error.message === 'body_too_large') return errorJson(res, 413, 'body_too_large');
      if (error instanceof SyntaxError) return errorJson(res, 400, 'invalid_json');
      return errorJson(res, 500, 'preview_server_error');
    }
  });

  return {
    server,
    state,
    listen(port = 0) {
      const requestedPort = Number(port);
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number.isInteger(requestedPort) ? requestedPort : 0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve(this);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => error ? reject(error) : resolve());
      });
    },
    url() {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Preview server is not listening');
      return `http://127.0.0.1:${address.port}`;
    },
  };
}

async function main() {
  if (process.env.TASK14_PREVIEW !== '1') {
    console.error('Refusing to start Task 14 preview: set TASK14_PREVIEW=1 explicitly.');
    process.exitCode = 1;
    return;
  }
  const preview = createTask14JournalPreviewServer();
  await preview.listen(process.env.TASK14_PREVIEW_PORT || 41714);
  console.log(`Task 14 journal preview: ${preview.url()}/gui/#/journal?capture=1&zone_uuid=${CANONICAL_IDS.zoneUuid}`);
}

module.exports = {
  CANONICAL_IDS,
  createTask14JournalPreviewServer,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
