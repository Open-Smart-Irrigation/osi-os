import assert from 'node:assert/strict';
import {test} from 'node:test';
import {api, devicesAPI, irrigationOutcomesAPI, irrigationZonesAPI, sensorAPI} from '../../src/services/api';
import {createDemoAdapter} from '../adapter';
import {PUBLIC_EPOCH, Simulator} from '../model';

test('shared meter reports aggregate deltas at simultaneous and asynchronous close boundaries', async () => {
  const simulator = new Simulator({mode: 'public'});
  api.defaults.adapter = createDemoAdapter(simulator);
  const firstValve = '00000000000000D1';
  const secondValve = '00000000000000D2';
  const flowEui = '00000000000000E1';
  const halfHour = 30 * 60_000;

  await irrigationZonesAPI.removeDevice(2, secondValve);
  await irrigationZonesAPI.assignDevice(1, secondValve);
  const assignedValves = (await devicesAPI.getAll()).filter(device => [firstValve, secondValve].includes(device.deveui));
  assert.deepEqual(assignedValves.map(device => device.irrigation_zone_id), [1, 1]);

  for (const eui of [firstValve, secondValve]) {
    await devicesAPI.controlValve(eui, {action: 'OPEN_FOR_DURATION', duration_seconds: 3600});
  }
  simulator.advanceTo(PUBLIC_EPOCH + halfHour);

  const simultaneous = (await devicesAPI.getAll()).find(device => device.deveui === flowEui)!;
  assert.equal(simultaneous.latest_data.flow_liters_delta, 359.6);
  assert.equal(simultaneous.latest_data.counter_interval_seconds, 1800);
  assert.equal(simultaneous.latest_data.flow_liters_per_10min, 119.87,
    'the normalized rate uses both valve deltas reported at the same meter timestamp');
  const runningOutcomes = (await irrigationOutcomesAPI.recentActuations()).actuations
    .filter(outcome => [firstValve, secondValve].includes(outcome.deviceEui));
  assert.deepEqual(runningOutcomes.map(outcome => [outcome.deviceEui, outcome.status, outcome.estimatedGrossLiters]).sort(), [
    [firstValve, 'RUNNING', 179.8], [secondValve, 'RUNNING', 179.8],
  ].sort());
  const simultaneousRateHistory = (await sensorAPI.getHistory(flowEui, 'flow_liters_per_10min', 1))
    .filter(point => Date.parse(point.t) > PUBLIC_EPOCH);
  assert.equal(simultaneousRateHistory.at(-1)?.value, 119.87);

  await devicesAPI.controlValve(firstValve, {action: 'CLOSE'});
  simulator.advanceTo(PUBLIC_EPOCH + halfHour + 2000);

  const closeReport = (await devicesAPI.getAll()).find(device => device.deveui === flowEui)!;
  assert.equal(closeReport.latest_data.flow_liters_delta, 0.4,
    'the closing valve and its still-open shared-meter peer contribute to the close report');
  assert.equal(closeReport.latest_data.counter_interval_seconds, 2);
  assert.equal(closeReport.latest_data.flow_liters_per_10min, 120);
  const outcomesAfterClose = (await irrigationOutcomesAPI.recentActuations()).actuations
    .filter(outcome => [firstValve, secondValve].includes(outcome.deviceEui));
  assert.equal(outcomesAfterClose.find(outcome => outcome.deviceEui === firstValve)?.estimatedGrossLiters, 180);
  assert.equal(outcomesAfterClose.find(outcome => outcome.deviceEui === secondValve)?.estimatedGrossLiters, 180,
    'integrating the shared meter boundary preserves the other command’s own delivered volume');

  simulator.advanceTo(PUBLIC_EPOCH + 60 * 60_000);
  const nextReport = (await devicesAPI.getAll()).find(device => device.deveui === flowEui)!;
  assert.equal(nextReport.latest_data.flow_liters_delta, 179.8);
  assert.equal(nextReport.latest_data.counter_interval_seconds, 1798,
    'the still-open valve resumes from the asynchronous close report boundary');
  assert.equal(nextReport.latest_data.flow_liters_per_10min, 60);
  const nextRateHistory = (await sensorAPI.getHistory(flowEui, 'flow_liters_per_10min', 1))
    .filter(point => Date.parse(point.t) > PUBLIC_EPOCH);
  assert.deepEqual(nextRateHistory.slice(-2).map(point => point.value), [120, 60]);
  const finalOutcomes = (await irrigationOutcomesAPI.recentActuations()).actuations
    .filter(outcome => [firstValve, secondValve].includes(outcome.deviceEui));
  assert.equal(finalOutcomes.find(outcome => outcome.deviceEui === firstValve)?.estimatedGrossLiters, 180);
  assert.equal(finalOutcomes.find(outcome => outcome.deviceEui === secondValve)?.estimatedGrossLiters, 359.8);
});
