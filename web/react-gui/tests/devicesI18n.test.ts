import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const localeRoot = path.resolve(process.cwd(), 'public/locales');

function readDevices(locale: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'devices.json'), 'utf8'));
}

function getPath(obj: Record<string, any>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, obj);
}

test('devices locale files include irrigation actuation translation keys', () => {
  // `stregaValve.actuationFeedback.*` is read by StregaValveCard.tsx
  // (getStregaActuationFeedback) -- the devices-tab card restored by the EDGE-2 operator
  // ruling (final fix wave) that sits alongside the Valve control panel's ValveTile.
  const requiredKeys = [
    'stregaValve.actuationFeedback.closed',
    'stregaValve.actuationFeedback.closedAt',
    'stregaValve.actuationFeedback.open',
    'stregaValve.actuationFeedback.openClosesAt',
    'stregaValve.actuationFeedback.openQueued',
    'stregaValve.actuationFeedback.waitingForUplink',
    'irrigationOutcomes.duration',
    'irrigationOutcomes.totalVolume',
    'irrigationOutcomes.irrigated',
    'irrigationOutcomes.timestampTitle',
    'irrigationOutcomes.settings',
    'irrigationOutcomes.advancedView',
    // `stregaValve.targetIntent.*` is read by StregaValveCard.tsx (getStregaTargetIntent) --
    // the ACK-path vocabulary shown next to an unconfirmed "Target: …" line (valve-state
    // honesty fix, polish scan 2026-09-17 Cat 6).
    'stregaValve.targetIntent.pending',
    'stregaValve.targetIntent.acknowledged',
    'stregaValve.targetIntent.failed',
    'stregaValve.targetIntent.expired',
    // R19 finding 1: the removal notice for a valve whose weekly plan is still being cleared.
    'stregaValve.removedClearingScheduled',
    'stregaValve.removedClearingFailed',
    'stregaValve.removedNoticeOk',
  ];

  for (const locale of ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt']) {
    const devices = readDevices(locale);
    for (const key of requiredKeys) {
      assert.equal(typeof getPath(devices, key), 'string', `${locale} missing ${key}`);
    }
  }
});

test('valve removal notice: lg ships the English source text until a human Luganda pass', () => {
  // docs/i18n/pending-luganda-translations.md, "devices.json — valve removal notice".
  const PENDING_HUMAN_LUGANDA = ['stregaValve.removedClearingScheduled', 'stregaValve.removedClearingFailed', 'stregaValve.removedNoticeOk'];
  const en = readDevices('en');
  const lg = readDevices('lg');
  for (const key of PENDING_HUMAN_LUGANDA) assert.equal(getPath(lg, key), getPath(en, key), key);
});
