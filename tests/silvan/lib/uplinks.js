'use strict';
// ChirpStack `event/up` envelope builders for simulated devices.
//
// Every `mqtt in` node in flows.json subscribes to the SAME literal topic,
// `application/+/device/+/event/up` (enforced by scripts/check-mqtt-topics.sh).
// Each decoder then self-filters on deviceInfo.deviceProfileId /
// deviceProfileName. So a simulator does NOT need a real ChirpStack device
// object or a real radio: publishing a crafted envelope to the local broker
// reaches exactly the decoders whose profile it claims.
//
// We populate `object` with ALREADY-DECODED fields, which is what ChirpStack
// itself hands Node-RED once its codec has run. Field names below were read out
// of the flow nodes that consume them, not guessed:
//   KIWI/CLOVER  -> flows.json node 81c98fb07344a787 ("Process Data")
//   STREGA       -> flows.json node strega-process-fn ("Process STREGA")
//   LSN50        -> flows.json node lsn50-decode-fn ("Decode LSN50")
//   S2120        -> flows.json node s2120-process-fn ("Process S2120")

const { assertSimulatedDevice } = require('./config');

// Resolved once per run from the gateway's own Node-RED environment so the
// simulator claims the same profile UUIDs the decoders are configured with.
function makeProfiles(env) {
  return {
    KIWI: env.CHIRPSTACK_PROFILE_KIWI,
    CLOVER: env.CHIRPSTACK_PROFILE_CLOVER,
    LSN50: env.CHIRPSTACK_PROFILE_LSN50,
    S2120: env.CHIRPSTACK_PROFILE_S2120,
    STREGA: env.CHIRPSTACK_PROFILE_STREGA,
    STREGA_GEN2: env.CHIRPSTACK_PROFILE_STREGA_GEN2 || null,
    SDI12: env.CHIRPSTACK_PROFILE_SDI12,
  };
}

function upTopic(appId, deveui) {
  return 'application/' + appId + '/device/' + String(deveui).toUpperCase() + '/event/up';
}

function envelope({ deveui, deviceName, profileId, profileName, object, fPort, time, data }) {
  assertSimulatedDevice(deveui);
  return {
    deduplicationId: require('node:crypto').randomUUID(),
    time: time || new Date().toISOString(),
    deviceInfo: {
      tenantId: '00000000-0000-0000-0000-000000000000',
      tenantName: 'ChirpStack',
      applicationId: '00000000-0000-0000-0000-000000000000',
      applicationName: 'osi-silvan-harness',
      deviceProfileId: profileId,
      deviceProfileName: profileName,
      deviceName: deviceName || 'sim-' + deveui,
      devEui: String(deveui).toUpperCase(),
    },
    devAddr: '00000000',
    adr: true,
    dr: 5,
    fCnt: Math.floor(Math.random() * 60000),
    fPort: fPort == null ? 2 : fPort,
    confirmed: false,
    data: data || null,
    object: object || {},
    rxInfo: [{ gatewayId: '0016c001f11715e2', rssi: -70, snr: 9.5, channel: 2 }],
    txInfo: { frequency: 868100000 },
  };
}

// --- KIWI / CLOVER soil-tension uplink -------------------------------------
// The flow converts watermark frequency (Hz) to kPa itself; kpaToHz is the
// inverse of the flow's own convertHzToKPa piecewise table, so a case can ask
// for "35 kPa" and get a frequency that decodes back to ~35 kPa.
function kpaToHz(kpa) {
  if (kpa == null) return null;
  const k = Number(kpa);
  if (!Number.isFinite(k)) return null;
  if (k <= 0) return 6500;
  if (k <= 9) return 4330 + (9 - k) / 0.004286;
  if (k <= 15) return 2820 + (15 - k) / 0.003974;
  if (k <= 35) return 1110 + (35 - k) / 0.01170;
  if (k <= 55) return 770 + (55 - k) / 0.05884;
  if (k <= 75) return 600 + (75 - k) / 0.1176;
  if (k <= 100) return 485 + (100 - k) / 0.2174;
  if (k <= 200) return 293 + (200 - k) / 0.5208;
  return 200;
}

function kiwiUplink(profiles, { deveui, deviceName, swt1Kpa, swt2Kpa, lightLux, temperatureC, humidityPct, time, clover = false }) {
  const object = {};
  const f1 = kpaToHz(swt1Kpa);
  const f2 = kpaToHz(swt2Kpa);
  if (f1 != null) object.watermark1_frequency = Math.round(f1);
  if (f2 != null) object.watermark2_frequency = Math.round(f2);
  if (lightLux != null) object.light_intensity = lightLux;
  if (temperatureC != null) object.ambient_temperature = temperatureC;
  if (humidityPct != null) object.relative_humidity = humidityPct;
  return envelope({
    deveui, deviceName, time, fPort: 2,
    profileId: clover ? profiles.CLOVER : profiles.KIWI,
    profileName: clover ? 'OSI TEKTELIC Clover' : 'OSI KIWI Sensor',
    object,
  });
}

// --- STREGA periodic status uplink -----------------------------------------
// `Valve` is the vendor's valve bit: "1" = OPEN, "0" = CLOSED
// (strega-process-fn normalizeStateFromValveBit). Temperature/Hygrometry are
// Gen1-only ENCLOSURE climate; 125/100 is the vendor sentinel the flow nulls.
function stregaStatusUplink(profiles, { deveui, deviceName, open, batteryPct = 100, temperatureC = null, humidityPct = null, gen2 = false, time, fPort = 4 }) {
  const object = { Valve: open ? '1' : '0', Battery: batteryPct };
  if (temperatureC != null) object.Temperature = temperatureC;
  if (humidityPct != null) object.Hygrometry = humidityPct;
  if (gen2) { delete object.Valve; object.Actuator = open ? '1' : '0'; }
  return envelope({
    deveui, deviceName, time, fPort,
    profileId: gen2 ? (profiles.STREGA_GEN2 || profiles.STREGA) : profiles.STREGA,
    profileName: gen2 ? 'OSI STREGA Valve Gen2' : 'OSI STREGA Valve',
    object,
  });
}

// --- STREGA scheduler / clock ACK uplinks ----------------------------------
// Shapes taken from osi-valve-control/ack.js interpretUplink() and the golden
// vectors in scripts/fixtures/strega-gen1/.
// `status` is the 2-char ASCII-hex string the vendor codec emits ('00' = OK).
function stregaGen1WeekdayAck(profiles, { deveui, deviceName, weekdayFport, status = '00', time }) {
  return envelope({
    deveui, deviceName, time, fPort: 2,
    profileId: profiles.STREGA, profileName: 'OSI STREGA Valve',
    object: { Schl_Port: weekdayFport, Schl_status: status },
  });
}

function stregaGen1StatusAck(profiles, { deveui, deviceName, status = '00', time }) {
  return envelope({
    deveui, deviceName, time, fPort: 2,
    profileId: profiles.STREGA, profileName: 'OSI STREGA Valve',
    object: { Schl_status_Port: 21, Schl_status_ack: status },
  });
}

function stregaGen1ClockAck(profiles, { deveui, deviceName, port = 12, status = '00', time }) {
  return envelope({
    deveui, deviceName, time, fPort: 2,
    profileId: profiles.STREGA, profileName: 'OSI STREGA Valve',
    object: { RTC_Port: port, RTC_status: status },
  });
}

// Gen2 ACK: `Ack_Port` (echoed port, positive integer) is what marks it; there
// is no boolean `Ack` field on real hardware (ack.js comment, verified).
function stregaGen2Ack(profiles, { deveui, deviceName, ackPort, ackValue = 0, time }) {
  return envelope({
    deveui, deviceName, time, fPort: 2,
    profileId: profiles.STREGA_GEN2 || profiles.STREGA,
    profileName: 'OSI STREGA Valve Gen2',
    object: { Ack_Port: ackPort, Ack_Value: ackValue },
  });
}

// --- DRAGINO LSN50 ----------------------------------------------------------
function lsn50Uplink(profiles, { deveui, deviceName, tempC, batV, adcCh0V, time }) {
  const object = {};
  if (tempC != null) object.TempC1 = tempC;
  if (batV != null) object.BatV = batV;
  if (adcCh0V != null) object.ADC_CH0V = adcCh0V;
  return envelope({
    deveui, deviceName, time, fPort: 2,
    profileId: profiles.LSN50, profileName: 'OSI Dragino LSN50',
    object,
  });
}

// --- SENSECAP S2120 weather station ----------------------------------------
// measurementId map read from s2120-process-fn.
const S2120_IDS = {
  ambientTemperature: '4097',
  relativeHumidity: '4098',
  lightLux: '4099',
  barometricPressureHpa: '4101',
  batPct: '4103',
  windDirectionDeg: '4104',
  windSpeedMps: '4105',
  uvIndex: '4190',
  windGustMps: '4191',
  rainGaugeCumulativeMm: '4113',
};

function s2120Uplink(profiles, { deveui, deviceName, readings = {}, time }) {
  const group = [];
  for (const [key, id] of Object.entries(S2120_IDS)) {
    if (readings[key] === undefined || readings[key] === null) continue;
    group.push({ measurementId: id, measurementValue: readings[key], type: key });
  }
  return envelope({
    deveui, deviceName, time, fPort: 2,
    profileId: profiles.S2120, profileName: 'OSI SenseCAP S2120',
    object: { messages: [group], valid: true },
  });
}

module.exports = {
  makeProfiles, upTopic, envelope, kpaToHz,
  kiwiUplink, stregaStatusUplink, lsn50Uplink, s2120Uplink,
  stregaGen1WeekdayAck, stregaGen1StatusAck, stregaGen1ClockAck, stregaGen2Ack,
  S2120_IDS,
};
