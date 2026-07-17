import { describe, expect, it } from 'vitest';

import type { JournalPlot } from '../../types/journal';
import { deriveStationModel } from '../stationModel';

const timestamp = '2026-07-17T00:00:00.000Z';

function plot(
  plotUuid: string,
  plotCode: string,
  stationCode: string | null = 'S1',
  name: string | null = null,
): JournalPlot {
  return {
    contract_version: 1,
    plot_uuid: plotUuid,
    plot_code: plotCode,
    name,
    zone_uuid: null,
    station_code: stationCode,
    crop_hint: null,
    area_m2: null,
    active: 1,
    sync_version: 1,
    owner_user_uuid: 'owner',
    gateway_device_eui: 'GATEWAY',
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    settings: {
      layout_code: 'open_field',
      updated_at: timestamp,
      updated_by_principal_uuid: 'principal',
      sync_version: 1,
    },
  };
}

describe('deriveStationModel', () => {
  it('extracts plot numbers from plot_code first and assigns stable one-based grid numbers', () => {
    const p07 = plot('p07', 'P-07', 'S1');
    const p02 = plot('p02', 'plot 2', 'S1');
    const p10 = plot('p10', 'Lysimeter 10', 'S1');

    const model = deriveStationModel('S1', [p10, p07, p02]);

    expect(model.gridPlots).toEqual([
      { plot: p02, gridNumber: 1, sourceNumber: 2 },
      { plot: p07, gridNumber: 2, sourceNumber: 7 },
      { plot: p10, gridNumber: 3, sourceNumber: 10 },
    ]);
    expect(model.namedFallbackPlots).toEqual([]);
    expect(model.unstationedPlots).toEqual([]);
  });

  it('uses an unambiguous plot_code before an unambiguous name', () => {
    const codeWins = plot('code-wins', 'P-07', 'S1', 'plot 2');

    expect(deriveStationModel('S1', [codeWins]).gridPlots).toEqual([
      { plot: codeWins, gridNumber: 1, sourceNumber: 7 },
    ]);
  });

  it('falls back to name only for ambiguous or unsafe plot codes', () => {
    const decimal = plot('decimal', '2.5', 'S1', 'plot 2');
    const exponent = plot('exponent', '1e3', 'S1', 'P-07');
    const multiple = plot('multiple', 'plot 2 row 3', 'S1', 'Lysimeter 10');
    const unsafe = plot('unsafe', '9007199254740992', 'S1', 'P-08');
    const ambiguousBoth = plot('both', 'plot 2 row 3', 'S1', 'name 4 row 5');

    const model = deriveStationModel('S1', [decimal, exponent, multiple, unsafe, ambiguousBoth]);

    expect(model.gridPlots.map(({ plot: item, sourceNumber }) => [item.plot_uuid, sourceNumber])).toEqual([
      ['decimal', 2],
      ['exponent', 7],
      ['unsafe', 8],
      ['multiple', 10],
    ]);
    expect(model.namedFallbackPlots).toEqual([ambiguousBoth]);
  });

  it.each([
    '.5',
    '5.',
    'plot .5',
    'plot 5.',
    '5e2',
    '1.5e2',
    '.5e2',
    '5.e2',
  ])('rejects numeric syntax %s before extracting digit runs', (plotCode) => {
    const invalidNumericSyntax = plot(`invalid-${plotCode}`, plotCode);
    const model = deriveStationModel('S1', [invalidNumericSyntax]);

    expect(model.gridPlots).toEqual([]);
    expect(model.namedFallbackPlots).toEqual([invalidNumericSyntax]);
  });

  it('moves every same-station source-number collision out of the grid', () => {
    const firstSeven = plot('first-seven', 'P-07');
    const secondSeven = plot('second-seven', 'plot 7');
    const eight = plot('eight', 'P-08');
    const named = plot('named', 'A', 'S1', 'North bed');
    const model = deriveStationModel('S1', [firstSeven, secondSeven, eight, named]);

    expect(model.gridPlots).toEqual([
      { plot: eight, gridNumber: 1, sourceNumber: 8 },
    ]);
    expect(model.namedFallbackPlots).toEqual([firstSeven, secondSeven, named]);
    expect(new Set([
      ...model.gridPlots.map(({ plot: item }) => item.plot_uuid),
      ...model.namedFallbackPlots.map((item) => item.plot_uuid),
    ])).toEqual(new Set(['first-seven', 'second-seven', 'eight', 'named']));
  });

  it('keeps plots without a station separate from station members', () => {
    const stationPlot = plot('station', 'P-01', 'S1');
    const unstationedNumeric = plot('unassigned', 'P-02', null);
    const unstationedNamed = plot('unassigned-named', 'North', null, 'North bed');

    const model = deriveStationModel('S1', [stationPlot, unstationedNumeric, unstationedNamed]);

    expect(model.gridPlots.map(({ plot: item }) => item.plot_uuid)).toEqual(['station']);
    expect(model.namedFallbackPlots).toEqual([]);
    expect(model.unstationedPlots).toEqual([unstationedNumeric, unstationedNamed]);
  });

  it('derives stations independently and exposes unstationed plots for one outside-loop render', () => {
    const stationOne = plot('station-one', 'P-07', 'S1');
    const stationTwo = plot('station-two', 'plot 7', 'S2');
    const unstationed = plot('unstationed', 'P-09', null);
    const plots = [stationOne, stationTwo, unstationed];

    const stationOneModel = deriveStationModel('S1', plots);
    const stationTwoModel = deriveStationModel('S2', plots);

    expect(stationOneModel.gridPlots).toEqual([
      { plot: stationOne, gridNumber: 1, sourceNumber: 7 },
    ]);
    expect(stationTwoModel.gridPlots).toEqual([
      { plot: stationTwo, gridNumber: 1, sourceNumber: 7 },
    ]);
    // Task 19 renders this shared collection once, outside the per-station loop.
    expect(stationOneModel.unstationedPlots).toEqual([unstationed]);
    expect(stationTwoModel.unstationedPlots).toEqual([unstationed]);
  });
});
