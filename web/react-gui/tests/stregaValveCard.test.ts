import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React from 'react';
import {
  I18nextProvider,
} from 'react-i18next';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  getDisplayedStregaState,
  getRecognizedStregaModel,
  StregaValveCard,
  shouldShowStregaTargetState,
} from '../src/components/farming/StregaValveCard.tsx';
import { buildDeviceFooterMeta } from '../src/components/farming/shared/deviceCardBattery.ts';
import type { Device } from '../src/types/farming.ts';

function buildDevice(overrides: Partial<Device> = {}): Device {
  return {
    deveui: '70B3D57708000334',
    name: 'Valve White',
    type_id: 'STREGA_VALVE',
    latest_data: {},
    current_state: 'CLOSED',
    target_state: 'CLOSED',
    ...overrides,
  };
}

async function renderStregaCard(device: Device): Promise<string> {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['devices', 'common'],
    defaultNS: 'devices',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    resources: {
      en: {
        common: {
          cancel: 'Cancel',
        },
        devices: {
          stregaValve: {
            badge: 'STREGA',
            settings: 'Settings',
            status: 'Status',
            open: 'Open',
            closed: 'Closed',
            target: 'Target: {{state}}',
            opening: 'Opening',
            closing: 'Closing',
            lastSeen: 'Last seen: {{minutes}} minutes ago',
            neverSeen: 'Never seen',
          },
        },
      },
    },
  });

  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(StregaValveCard, { device, onUpdate: () => {} }),
    ),
  );
}

function getRenderedText(html: string): string {
  const dom = new JSDOM(html);
  return dom.window.document.body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

test('explicit motorized model wins over legacy name heuristics', () => {
  const device = buildDevice({
    name: 'Standard valve',
    strega_model: 'MOTORIZED',
  });

  assert.equal(getRecognizedStregaModel(device), 'MOTORIZED');
});

test('unknown model stays locked until explicit metadata or a known name hint exists', () => {
  const device = buildDevice({
    name: 'Valve White',
    strega_model: null,
  });

  assert.equal(getRecognizedStregaModel(device), 'UNKNOWN');
});

test('battery footer renders when STREGA battery percent is available', () => {
  const device = buildDevice({
    latest_data: {
      bat_pct: 88,
    },
  });

  assert.equal(
    buildDeviceFooterMeta({ batPct: device.latest_data?.bat_pct, lastSeenLabel: '5 min ago' }),
    '🔋 88% · 5 min ago',
  );
});

test('renders a battery footer when STREGA battery percent is 100', async () => {
  const html = await renderStregaCard(
    buildDevice({
      latest_data: {
        bat_pct: 100,
      },
    }),
  );

  assert.ok(getRenderedText(html).includes('🔋 100% · Never seen'));
});

test('renders Never seen when STREGA last_seen is null', async () => {
  const html = await renderStregaCard(
    buildDevice({
      last_seen: null,
    }),
  );

  assert.ok(getRenderedText(html).includes('Never seen'));
});

test('renders the translated last-seen label when STREGA last_seen is valid', async () => {
  const originalDateNow = Date.now;
  Date.now = () => new Date('2026-04-23T12:00:00Z').getTime();

  try {
    const html = await renderStregaCard(
      buildDevice({
        last_seen: '2026-04-23T11:55:00Z',
      }),
    );

    assert.ok(getRenderedText(html).includes('Last seen: 5 minutes ago'));
  } finally {
    Date.now = originalDateNow;
  }
});

test('current state stays primary while a different target state is shown as pending', () => {
  const device = buildDevice({
    current_state: 'CLOSED',
    target_state: 'OPEN',
  });

  assert.equal(getDisplayedStregaState(device), 'CLOSED');
  assert.equal(shouldShowStregaTargetState(device), true);
});

test('target state becomes the displayed fallback when current state is still missing', () => {
  const device = buildDevice({
    current_state: undefined,
    target_state: 'OPEN',
  });

  assert.equal(getDisplayedStregaState(device), 'OPEN');
  assert.equal(shouldShowStregaTargetState(device), true);
});
