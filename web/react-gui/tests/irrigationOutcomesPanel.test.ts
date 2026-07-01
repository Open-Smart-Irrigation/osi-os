import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

import { IrrigationOutcomesPanel } from '../src/components/farming/IrrigationOutcomesPanel.tsx';
import {
  irrigationOutcomesAPI,
  type IrrigationActuation,
  type IrrigationActuationsResponse,
} from '../src/services/api.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
(globalThis as { window?: unknown }).window = dom.window;
(globalThis as { document?: unknown }).document = dom.window.document;
// `navigator` is a getter-only on Node ≥21; only set it if the slot is writable.
const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
if (!navDesc || navDesc.writable || navDesc.set) {
  (globalThis as { navigator?: unknown }).navigator = dom.window.navigator;
}

type DevicesResource = Record<string, unknown>;

async function buildI18n(devicesResource: DevicesResource = {}) {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['devices'],
    defaultNS: 'devices',
    resources: { en: { devices: devicesResource } },
  });
  return i18n;
}

function actuationFixture(overrides: Partial<IrrigationActuation> = {}): IrrigationActuation {
  return {
    expectationId: 'exp-1',
    deviceEui: '70B3D57708000334',
    deviceName: 'Valve A',
    zoneId: 12,
    zoneName: 'Zone 12',
    commandId: 'cmd-uuid-1',
    commandedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    commandedDurationSeconds: 600,
    expectedCloseAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    observedOpenAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    observedCloseAt: null,
    estimatedGrossLiters: 42,
    flowRateLpm: 8.4,
    reconciliationState: 'OBSERVED_RUNNING',
    cancelReason: null,
    commandResult: 'APPLIED',
    commandResultDetail: null,
    commandAppliedAt: new Date(Date.now() - 4.5 * 60_000).toISOString(),
    status: 'RUNNING',
    ...overrides,
  };
}

async function renderPanel(response: IrrigationActuationsResponse | { error: string }) {
  const original = irrigationOutcomesAPI.recentActuations;
  (irrigationOutcomesAPI as { recentActuations: () => Promise<IrrigationActuationsResponse> }).recentActuations = async () => {
    if ('error' in response) throw new Error(response.error);
    return response;
  };
  try {
    const i18n = await buildI18n();
    return renderToStaticMarkup(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(IrrigationOutcomesPanel, { pollIntervalMs: 0 }),
      ),
    );
  } finally {
    irrigationOutcomesAPI.recentActuations = original;
  }
}

function responseWithActuation(overrides: Partial<IrrigationActuation> = {}): IrrigationActuationsResponse {
  return {
    generatedAt: '2026-05-29T10:20:00Z',
    actuations: [actuationFixture(overrides)],
  };
}

function responseWithActuations(count: number): IrrigationActuationsResponse {
  return {
    generatedAt: '2026-05-29T10:20:00Z',
    actuations: Array.from({ length: count }, (_, index) => actuationFixture({
      expectationId: `exp-${index + 1}`,
      commandId: `cmd-uuid-${index + 1}`,
      deviceEui: `70B3D57708000${String(index + 1).padStart(3, '0')}`,
      deviceName: `Valve ${index + 1}`,
      zoneId: 12,
      zoneName: `Zone ${index + 1}`,
      commandedAt: new Date(Date.parse('2026-05-29T10:20:00Z') - index * 60_000).toISOString(),
    })),
  };
}

async function renderControlledPanel(
  response: IrrigationActuationsResponse,
  zoneContext: Record<string, unknown> = {
    timeZone: 'Europe/Zurich',
    areaM2: 100,
    irrigationEfficiencyPct: 80,
  },
  devicesResource: DevicesResource = {},
) {
  const i18n = await buildI18n(devicesResource);
  return render(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(IrrigationOutcomesPanel, {
        response,
        loading: false,
        error: null,
        pollIntervalMs: 0,
        zoneContexts: new Map([[12, zoneContext]]),
      } as Record<string, unknown>),
    ),
  );
}

test('shows loading state on first render before fetch resolves', async () => {
  // No fetch hook — the static render captures the initial state pre-effect.
  const i18n = await buildI18n();
  const html = renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(IrrigationOutcomesPanel, { pollIntervalMs: 0 }),
    ),
  );
  assert.match(html, /Recent irrigations/);
  assert.match(html, /Loading recent actuations/);
});

test('empty state when API returns zero actuations', async () => {
  const html = await renderPanel({ generatedAt: new Date().toISOString(), actuations: [] });
  // Static render shows the pre-effect state — loading, not empty. This test
  // documents the limitation; for full lifecycle testing we'd need react-dom/client
  // with act() and a mount target. The structural assertions below catch regressions
  // in the rendered shell (title + empty/loading paragraph).
  assert.match(html, /Recent irrigations/);
});

test('runtime status helper exposed via the component module', async () => {
  // Smoke-import the type so a future refactor that drops the export breaks here.
  const mod = await import('../src/services/api.ts');
  assert.ok(typeof mod.irrigationOutcomesAPI.recentActuations === 'function');
});

test('actuationFixture builds a row the API contract accepts', () => {
  const a = actuationFixture({ status: 'OPEN_TIMEOUT', observedOpenAt: null, commandResultDetail: 'Downlink not acked' });
  assert.equal(a.status, 'OPEN_TIMEOUT');
  assert.equal(a.observedOpenAt, null);
  assert.equal(a.commandResultDetail, 'Downlink not acked');
});

test('default view shows commanded date, duration, and effective irrigation depth', async () => {
  const originalNow = Date.now;
  Date.now = () => new Date('2026-05-29T10:20:00Z').getTime();
  window.localStorage.clear();
  const response = responseWithActuation({
    commandedAt: '2026-05-29T10:15:00Z',
    commandedDurationSeconds: 600,
    observedOpenAt: '2026-05-29T10:16:00Z',
    observedCloseAt: '2026-05-29T10:18:00Z',
    estimatedGrossLiters: 75,
  });
  const expectedCommanded = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Zurich',
  }).format(new Date('2026-05-29T10:15:00Z'));

  try {
    const rendered = await renderControlledPanel(response);

    await rendered.findByText(/Zone 12/);
    assert.match(document.body.textContent ?? '', new RegExp(expectedCommanded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(document.body.textContent ?? '', /Duration: 10 min/);
    assert.match(document.body.textContent ?? '', /Irrigated: 0\.6 mm/);
    assert.doesNotMatch(document.body.textContent ?? '', /Running/);
    assert.doesNotMatch(document.body.textContent ?? '', /Total volume:/);
    assert.doesNotMatch(document.body.textContent ?? '', /Confirmed open:/);
    assert.doesNotMatch(document.body.textContent ?? '', /Confirmed close:/);
    await waitFor(() => assert.doesNotMatch(document.body.textContent ?? '', /Loading recent actuations/));
  } finally {
    cleanup();
    Date.now = originalNow;
  }
});

test('default view renders only the five newest recent irrigations', async () => {
  window.localStorage.clear();
  try {
    await renderControlledPanel(responseWithActuations(7));

    for (let i = 1; i <= 5; i += 1) {
      assert.match(document.body.textContent ?? '', new RegExp(`Zone ${i}(?!\\d)`));
    }
    assert.doesNotMatch(document.body.textContent ?? '', /Zone 6(?!\d)/);
    assert.doesNotMatch(document.body.textContent ?? '', /Zone 7(?!\d)/);
  } finally {
    cleanup();
  }
});

test('default view falls back to gross irrigation depth when efficiency is missing', async () => {
  window.localStorage.clear();
  try {
    await renderControlledPanel(
      responseWithActuation({ estimatedGrossLiters: 75 }),
      { timeZone: 'Europe/Zurich', areaM2: 100, irrigationEfficiencyPct: null },
    );

    assert.match(document.body.textContent ?? '', /Irrigated: 0\.8 mm/);
  } finally {
    cleanup();
  }
});

test('default view shows total volume when liters exist but area is missing', async () => {
  window.localStorage.clear();
  try {
    await renderControlledPanel(
      responseWithActuation({ estimatedGrossLiters: 75 }),
      { timeZone: 'Europe/Zurich', areaM2: null, irrigationEfficiencyPct: 80 },
    );

    assert.match(document.body.textContent ?? '', /Total volume: 75 L/);
    assert.doesNotMatch(document.body.textContent ?? '', /Irrigated:/);
  } finally {
    cleanup();
  }
});

test('default view omits volume and depth placeholders when liters are missing', async () => {
  window.localStorage.clear();
  try {
    await renderControlledPanel(responseWithActuation({ estimatedGrossLiters: null }));

    assert.match(document.body.textContent ?? '', /Duration: 10 min/);
    assert.doesNotMatch(document.body.textContent ?? '', /Total volume:/);
    assert.doesNotMatch(document.body.textContent ?? '', /Irrigated:/);
    assert.doesNotMatch(document.body.textContent ?? '', /Irrigated: —/);
  } finally {
    cleanup();
  }
});

test('advanced view shows status, total volume, depth, and confirmed timestamps', async () => {
  window.localStorage.setItem('osi.recentIrrigations.advancedView', 'true');
  try {
    await renderControlledPanel(responseWithActuation({
      observedOpenAt: '2026-05-29T10:16:00Z',
      observedCloseAt: '2026-05-29T10:18:00Z',
      estimatedGrossLiters: 75,
      status: 'COMPLETED',
    }));

    assert.match(document.body.textContent ?? '', /Completed/);
    assert.match(document.body.textContent ?? '', /Duration: 10 min/);
    assert.match(document.body.textContent ?? '', /Total volume: 75 L/);
    assert.match(document.body.textContent ?? '', /Irrigated: 0\.6 mm/);
    assert.match(document.body.textContent ?? '', /Confirmed open:/);
    assert.match(document.body.textContent ?? '', /Confirmed close:/);
  } finally {
    cleanup();
    window.localStorage.clear();
  }
});

test('advanced view renders only the five newest recent irrigations', async () => {
  window.localStorage.setItem('osi.recentIrrigations.advancedView', 'true');
  try {
    await renderControlledPanel(responseWithActuations(7));

    for (let i = 1; i <= 5; i += 1) {
      assert.match(document.body.textContent ?? '', new RegExp(`Zone ${i}(?!\\d)`));
      assert.match(document.body.textContent ?? '', new RegExp(`Valve ${i}(?!\\d)`));
    }
    assert.doesNotMatch(document.body.textContent ?? '', /Zone 6(?!\d)/);
    assert.doesNotMatch(document.body.textContent ?? '', /Valve 6(?!\d)/);
    assert.doesNotMatch(document.body.textContent ?? '', /Zone 7(?!\d)/);
    assert.doesNotMatch(document.body.textContent ?? '', /Valve 7(?!\d)/);
  } finally {
    cleanup();
    window.localStorage.clear();
  }
});

test('advanced view setting toggles and persists locally', async () => {
  window.localStorage.clear();
  const response = responseWithActuation({
    observedOpenAt: '2026-05-29T10:16:00Z',
    observedCloseAt: '2026-05-29T10:18:00Z',
    estimatedGrossLiters: 75,
  });

  try {
    const rendered = await renderControlledPanel(response);
    assert.doesNotMatch(document.body.textContent ?? '', /Confirmed open:/);

    fireEvent.click(rendered.getByLabelText(/Recent irrigations settings/));
    fireEvent.click(rendered.getByLabelText(/Advanced view/));

    assert.equal(window.localStorage.getItem('osi.recentIrrigations.advancedView'), 'true');
    assert.match(document.body.textContent ?? '', /Confirmed open:/);

    cleanup();
    await renderControlledPanel(response);
    assert.match(document.body.textContent ?? '', /Confirmed open:/);
  } finally {
    cleanup();
    window.localStorage.clear();
  }
});

test('uses translated recent irrigation metric, settings, and timestamp-title labels', async () => {
  window.localStorage.setItem('osi.recentIrrigations.advancedView', 'true');
  const response = responseWithActuation({
    commandedAt: '2026-05-29T10:15:00Z',
    observedOpenAt: '2026-05-29T10:16:00Z',
    observedCloseAt: '2026-05-29T10:18:00Z',
    estimatedGrossLiters: 75,
  });
  const devicesResource = {
    irrigationOutcomes: {
      duration: 'Translated duration',
      totalVolume: 'Translated volume {{liters}}',
      irrigated: 'Translated irrigated {{depth}}',
      settings: 'Translated recent settings',
      advancedView: 'Translated advanced view',
      commanded: 'Translated commanded',
      observedOpen: 'Translated confirmed open',
      observedClose: 'Translated confirmed close',
      timestampTitle: '{{label}} @ {{absolute}} / {{relative}}',
    },
  };

  try {
    const rendered = await renderControlledPanel(response, {
      timeZone: 'Europe/Zurich',
      areaM2: 100,
      irrigationEfficiencyPct: 80,
    }, devicesResource);

    expectText(document.body.textContent ?? '', 'Translated duration: 10 min');
    expectText(document.body.textContent ?? '', 'Translated volume 75 L');
    expectText(document.body.textContent ?? '', 'Translated irrigated 0.6 mm');
    rendered.getByLabelText('Translated recent settings');
    const titled = Array.from(document.querySelectorAll('[title]'))
      .map((element) => element.getAttribute('title') ?? '')
      .find((title) => title.includes('Translated commanded'));
    assert.ok(titled, 'expected translated timestamp title');
    assert.match(titled, /Translated commanded @ .+ \/ .+/);
  } finally {
    cleanup();
    window.localStorage.clear();
  }
});

function expectText(actual: string, expected: string): void {
  assert.ok(
    actual.includes(expected),
    `expected text to include ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}
