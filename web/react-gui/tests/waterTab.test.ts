import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18next from 'i18next';

import { WaterTab } from '../src/components/farming/environment/WaterTab.tsx';

async function buildI18n() {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['devices'],
    defaultNS: 'devices',
    resources: { en: { devices: {} } },
  });
  return i18n;
}

test('WaterTab labels measured and estimated irrigation separately', async () => {
  const i18n = await buildI18n();
  const html = renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(WaterTab, {
        // Each tile is gated on a source the zone actually has, so the fixture
        // declares the flow meter and the valve the two tiles report on.
        devices: [
          { deveui: 'A1', type_id: 'DRAGINO_LSN50', flow_meter_enabled: 1 },
          { deveui: 'A2', type_id: 'STREGA_VALVE' },
        ] as any,
        water: {
          available: true,
          observedAt: '2026-05-29T10:00:00.000Z',
          areaM2: 100,
          irrigationEfficiencyPct: 80,
          rainTodayMm: 2,
          irrigationTodayLiters: 40,
          irrigationTodayNetMm: 0.32,
          irrigationTodayMeasuredLiters: 40,
          irrigationTodayEstimatedLiters: 75,
          measuredIrrigationNetMm: 0.32,
          estimatedIrrigationNetMm: 0.6,
          waterNeededTodayMm: 4,
          balanceTodayMm: -3.08,
          next24hRainMm: 1,
          action: null,
          daily: [],
          sensorHealth: {
            sensorCount: 1,
            freshSensorCount: 1,
            staleSensorCount: 0,
            rainGaugePresent: true,
            flowMeterPresent: true,
            warnings: [],
          },
        } as any,
      }),
    ),
  );

  assert.match(html, /Measured \(flow meter\)/);
  assert.match(html, /Estimated \(valve time/);
  assert.match(html, /40 L/);
  assert.match(html, /75 L/);
});

test('WaterTab does not relabel legacy irrigation fields as measured flow-meter values', async () => {
  const i18n = await buildI18n();
  const html = renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(WaterTab, {
        devices: [{ deveui: 'A1', type_id: 'DRAGINO_LSN50', flow_meter_enabled: 1 }] as any,
        water: {
          available: true,
          observedAt: '2026-05-29T10:00:00.000Z',
          areaM2: 100,
          irrigationEfficiencyPct: 80,
          rainTodayMm: 2,
          irrigationTodayLiters: 123,
          irrigationTodayNetMm: 0.98,
          waterNeededTodayMm: 4,
          balanceTodayMm: null,
          next24hRainMm: 1,
          action: null,
          daily: [{
            date: '2026-05-29',
            rainMm: 2,
            irrigationLiters: 123,
            irrigationNetMm: 0.98,
            totalWaterMm: 2.98,
          }],
          sensorHealth: {
            sensorCount: 1,
            freshSensorCount: 1,
            staleSensorCount: 0,
            rainGaugePresent: true,
            flowMeterPresent: false,
            warnings: [],
          },
        },
      }),
    ),
  );

  assert.match(html, /Measured \(flow meter\)/);
  assert.doesNotMatch(html, /123 L/);
  assert.doesNotMatch(html, /0\.98 mm effective/);
});

const BASE_WATER = {
  available: true,
  observedAt: '2026-05-29T10:00:00.000Z',
  areaM2: 100,
  irrigationEfficiencyPct: 80,
  rainTodayMm: 0,
  irrigationTodayLiters: 0,
  irrigationTodayNetMm: 0,
  irrigationTodayMeasuredLiters: 0,
  irrigationTodayEstimatedLiters: 0,
  measuredIrrigationNetMm: 0,
  estimatedIrrigationNetMm: 0,
  waterNeededTodayMm: null,
  balanceTodayMm: null,
  next24hRainMm: null,
  action: null,
  daily: [{ date: '2026-05-29', rainMm: 0, irrigationLiters: 0, irrigationNetMm: 0, totalWaterMm: 0 }],
  sensorHealth: {
    sensorCount: 0,
    freshSensorCount: 0,
    staleSensorCount: 0,
    rainGaugePresent: false,
    flowMeterPresent: false,
    warnings: [],
  },
};

async function renderWaterTab(props: Record<string, unknown>) {
  const i18n = await buildI18n();
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(WaterTab, props as any),
    ),
  );
}

test('WaterTab prints no tile for a source the zone does not have', async () => {
  // The empty zone: no devices at all, and the aggregation writes 0 for every
  // day with no sample. Every number on this tab was invented.
  const html = await renderWaterTab({ water: BASE_WATER, devices: [] });

  assert.doesNotMatch(html, /Rain today/);
  assert.doesNotMatch(html, /Measured \(flow meter\)/);
  assert.doesNotMatch(html, /Estimated \(valve time/);
  assert.doesNotMatch(html, /0 L/);
  assert.doesNotMatch(html, /0\.0 mm/);
});

test('WaterTab keeps a measured zero when the zone has the sensor behind it', async () => {
  const html = await renderWaterTab({
    water: {
      ...BASE_WATER,
      sensorHealth: { ...BASE_WATER.sensorHealth, rainGaugePresent: true },
    },
    devices: [{ deveui: 'A1', type_id: 'DRAGINO_LSN50', flow_meter_enabled: 1 }],
  });

  assert.match(html, /Rain today/);
  assert.match(html, /0\.0 mm/);
  assert.match(html, /Measured \(flow meter\)/);
});

test('WaterTab hides the seven-day chart when no source feeds it', async () => {
  const html = await renderWaterTab({ water: BASE_WATER, devices: [] });

  assert.doesNotMatch(html, /7-day water trend/);
});

test('WaterTab hides the demand and balance tiles until they can be computed', async () => {
  const html = await renderWaterTab({
    water: { ...BASE_WATER, sensorHealth: { ...BASE_WATER.sensorHealth, rainGaugePresent: true } },
    devices: [],
  });

  assert.doesNotMatch(html, /Setup required/);
  assert.doesNotMatch(html, /Water needed today/);
  assert.doesNotMatch(html, /Balance/);
});
