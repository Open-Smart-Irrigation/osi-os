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
