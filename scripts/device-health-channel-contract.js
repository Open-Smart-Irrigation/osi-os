'use strict';

const DEVICE_HEALTH_ALLOWLIST = ['bat_v', 'bat_pct', 'valve_1_pulse', 'valve_2_pulse'];
const DEVICE_HEALTH_AGGREGATION = Object.freeze({
  bat_v: 'mean',
  bat_pct: 'mean',
  valve_1_pulse: 'latest',
  valve_2_pulse: 'latest',
});

function normalizeDeviceHealthChannel(entry) {
  return {
    key: entry.key,
    unit: entry.unit ?? null,
    edgeField: entry.edgeField ?? null,
    cardType: entry.cardType,
    exportable: entry.exportable === true,
    aggregation: entry.aggregation ?? null,
  };
}

function assertDeviceHealthChannels(actualEntries, manifestEntries, label) {
  const actual = actualEntries.map(normalizeDeviceHealthChannel);
  const expected = DEVICE_HEALTH_ALLOWLIST.map((key) => {
    const manifestEntry = manifestEntries.find((entry) => entry.key === key);
    if (!manifestEntry) throw new Error(`${label} manifest is missing allowlisted key ${key}`);
    if (manifestEntry.cardType !== 'gateway' || manifestEntry.exportable !== false) {
      throw new Error(`${label} manifest entry ${key} must be gateway and exportable:false`);
    }
    return {
      key,
      unit: manifestEntry.unit ?? null,
      edgeField: manifestEntry.edgeField ?? null,
      cardType: 'device_health',
      exportable: false,
      aggregation: DEVICE_HEALTH_AGGREGATION[key],
    };
  });
  const actualKeys = actual.map((entry) => entry.key).sort();
  const expectedKeys = expected.map((entry) => entry.key).sort();
  if (actualKeys.join('\n') !== expectedKeys.join('\n')) {
    const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
    const extra = actualKeys.filter((key) => !expectedKeys.includes(key));
    throw new Error(`${label} key mismatch; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
  }
  for (const expectedEntry of expected) {
    const actualEntry = actual.find((entry) => entry.key === expectedEntry.key);
    if (JSON.stringify(actualEntry) !== JSON.stringify(expectedEntry)) {
      throw new Error(`${label} metadata mismatch for ${expectedEntry.key}; actual=${JSON.stringify(actualEntry)} expected=${JSON.stringify(expectedEntry)}`);
    }
  }
  return actual.length;
}

module.exports = {
  DEVICE_HEALTH_ALLOWLIST,
  DEVICE_HEALTH_AGGREGATION,
  assertDeviceHealthChannels,
  normalizeDeviceHealthChannel,
};
