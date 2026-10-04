import { describe, expect, it } from 'vitest';
import { normaliseHistoryCardSummary } from '../api';

describe('history card source normalization', () => {
  it('preserves per-source Chameleon flags from camel and snake case payloads', () => {
    const card = normaliseHistoryCardSummary({
      cardType: 'soil',
      sourceDevices: [
        { name: 'Watermark', typeId: 'DRAGINO_LSN50', role: 'soil', chameleon_enabled: 0 },
        { name: 'Chameleon', type_id: 'DRAGINO_LSN50', role: 'soil', chameleonEnabled: true },
      ],
    });

    expect(card.sourceDevices?.map((source) => source.chameleonEnabled)).toEqual([false, true]);
  });
});
