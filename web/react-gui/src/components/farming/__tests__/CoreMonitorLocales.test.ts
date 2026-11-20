// @vitest-environment node
import ledger from '../../../../../../docs/i18n/pending-luganda-translations.md?raw';
import { describe, expect, it } from 'vitest';
import en from '../../../../public/locales/en/devices.json';
import lg from '../../../../public/locales/lg/devices.json';

// Remove a key from this list and the B2 ledger when a human translation lands.
const PENDING_HUMAN_LUGANDA = [
  'rainMonitor.noData',
  'rainMonitor.windowTotal',
  'rainMonitor.peakInterval',
  'rainMonitor.wetIntervals',
  'rainMonitor.rainyDays',
  'rainMonitor.wettestDay',
  'rainMonitor.noIntervalData',
  'rainMonitor.noWindowData',
  'rainMonitor.intervalTitle',
  'rainMonitor.dailyTitle',
  'monitor.current',
  'monitor.minimum',
  'monitor.maximum',
  'monitor.hours',
  'monitor.days',
  'monitor.readings',
  'monitor.noData',
  'monitor.failedToLoad',
  'windMonitor.currentSpeed',
  'windMonitor.peakGust',
  'windMonitor.currentDirection',
  'windMonitor.speed',
  'windMonitor.gust',
  'windMonitor.direction',
  'windMonitor.speedAndGust',
  'windMonitor.roseTitle',
  'windMonitor.samples',
  'windMonitor.noData',
  'windMonitor.noSpeedData',
  'windMonitor.notEnoughData',
  'windMonitor.allCalm',
  'windMonitor.chartError',
  'windMonitor.timestamps',
  'dendrometerMonitor.title',
  'dendrometerMonitor.aboveRange',
  'dendrometerMonitor.belowRange',
  'dendrometerMonitor.noData',
  'dendrometerMonitor.rawOnly',
  'dendrometerMonitor.awaitingBaseline',
  'dendrometerMonitor.noCalibratedData',
  'dendrometerMonitor.stemTitle',
  'dendrometerMonitor.stemDescription',
  'dendrometerMonitor.mechanicalTitle',
  'dendrometerMonitor.mechanicalDescription',
  'dendrometerMonitor.engineering',
  'dendrometerMonitor.currentPosition',
  'dendrometerMonitor.windowRange',
  'dendrometerMonitor.strokeUsed',
  'dendrometerMonitor.strokeValue',
  'dendrometerMonitor.rangeState',
  'dendrometerMonitor.outsideRange',
  'dendrometerMonitor.calibrationDetails'
] as const;

function lookup(resource: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined, resource);
}

describe('B2 monitor Luganda fallback policy', () => {
  it('ships English for every key awaiting human translation', () => {
    for (const key of PENDING_HUMAN_LUGANDA) {
      const english = lookup(en, key);
      expect(english, `${key} is missing its English source`).toBeTypeOf('string');
      expect(lookup(lg, key), `${key} requires a human Luganda source before translation`).toBe(english);
    }
  });

  it('keeps the B2 ledger and fallback list equal', () => {
    const section = ledger.split('## UI FIX-LIST B2 (Monitors)')[1]?.split('\n## ')[0] ?? '';
    const recorded = [...section.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((key) => key !== 'devices.json' && key !== 'lg');
    expect(new Set(recorded)).toEqual(new Set(PENDING_HUMAN_LUGANDA));
  });
});
