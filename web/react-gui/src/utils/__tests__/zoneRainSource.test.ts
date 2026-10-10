import { describe, expect, it } from 'vitest';
import { initialRainGaugeChoice, normaliseZoneRainSource } from '../zoneRainSource';

describe('normaliseZoneRainSource', () => {
  it('reads the gateway payload of GET /api/irrigation-zones/:id/rain-source', () => {
    expect(normaliseZoneRainSource({
      state: 'ambiguous',
      selected_deveui: null,
      basis: null,
      candidates: [
        { deveui: 'a840410000000001', name: 'Gauge north', type_id: 'AQUASCOPE_LORAIN', via: 'direct' },
        { deveui: 'A840410000000002', name: null, type_id: 'SENSECAP_S2120', via: 'weather_station' },
      ],
      suggested_deveui: 'a840410000000001',
    })).toEqual({
      state: 'ambiguous',
      selectedDeveui: null,
      basis: null,
      candidates: [
        { deveui: 'A840410000000001', name: 'Gauge north', typeId: 'AQUASCOPE_LORAIN', via: 'direct' },
        { deveui: 'A840410000000002', name: null, typeId: 'SENSECAP_S2120', via: 'weather_station' },
      ],
      suggestedDeveui: 'A840410000000001',
    });
  });

  it('reads an explicit selection', () => {
    const source = normaliseZoneRainSource({
      state: 'selected', selected_deveui: 'A840410000000002', basis: 'explicit',
      candidates: [{ deveui: 'A840410000000002', name: 'Station', type_id: 'SENSECAP_S2120', via: 'weather_station' }],
      suggested_deveui: null,
    });
    expect(source.state).toBe('selected');
    expect(source.basis).toBe('explicit');
    expect(initialRainGaugeChoice(source)).toBe('A840410000000002');
  });

  it('starts the select empty unless the operator chose the gauge', () => {
    expect(initialRainGaugeChoice(normaliseZoneRainSource({
      state: 'selected', selected_deveui: 'A840410000000001', basis: 'only_candidate',
      candidates: [{ deveui: 'A840410000000001', name: 'Gauge', type_id: 'AQUASCOPE_LORAIN', via: 'direct' }],
      suggested_deveui: null,
    }))).toBe('');
    expect(initialRainGaugeChoice(null)).toBe('');
  });

  it('falls back to no gauge for an unreadable answer and drops malformed candidates', () => {
    expect(normaliseZoneRainSource(null)).toEqual({
      state: 'none', selectedDeveui: null, basis: null, candidates: [], suggestedDeveui: null,
    });
    const source = normaliseZoneRainSource({
      state: 'surprise', basis: 'whatever',
      candidates: [{ deveui: '' }, 'junk', { deveui: 'A840410000000003', via: 'elsewhere' }],
    });
    expect(source.state).toBe('none');
    expect(source.basis).toBeNull();
    expect(source.candidates).toEqual([{ deveui: 'A840410000000003', name: null, typeId: null, via: 'direct' }]);
  });
});
