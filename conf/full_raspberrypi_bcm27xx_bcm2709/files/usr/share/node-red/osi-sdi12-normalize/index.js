'use strict';
// osi-sdi12-normalize — probe-profile parsing for the Dragino SDI-12-LB/LS.
// Spec: docs/superpowers/specs/2026-08-13-dragino-sdi12-soil-node-design.md.
// Profiles are data: adding/correcting a probe is a registry edit + a test
// fixture, never an architecture change. Profiles marked provisional:true
// are datasheet-derived hypotheses awaiting bench capture.

var VALUE_RE = /^([+-]\d+(?:\.\d+)?)+$/;
var EXTRACT_RE = /[+-]\d+(?:\.\d+)?/g;

var TRANSFORMS = {
  pf_to_kpa: function (v) { return Math.pow(10, v) / 10; },
  hpa_to_kpa: function (v) { return v / 10; },
  // Legacy EnviroSCAN TriSCAN moisture rows are auto-configured with the
  // identity coefficients A=1, B=1, C=0. Their aM! value is therefore the
  // normalized scaled frequency, not VWC percent. Convert it with Sentek's
  // default moisture curve: SF = A * VWC^B + C. VIC from aM2! is already the
  // probe's nominal ion-content value and must not pass through this curve.
  sentek_sf_to_vwc: function (sf) {
    var a = 0.1957;
    var b = 0.404;
    var c = 0.02852;
    if (!Number.isFinite(sf) || sf < 0) return NaN;
    if (sf <= c) return 0;
    return Math.pow((sf - c) / a, 1 / b);
  }
};

// Budget assumption: 3 header bytes + worst-case 9 ASCII chars per value
// (sign + 8; bench-measured against real Sentek value widths, e.g.
// "+123.456" plus a sign/margin digit -- corrected from the original
// datasheet-derived 7).
// Dragino delivers at most 51 bytes per FPort 2 uplink at DR0; oversized
// frames are dropped by the device. Fixed-cardinality profiles must fit.
var UPLINK_HEADER_BYTES = 3;
var WORST_CHARS_PER_VALUE = 9;
var MULTI_SEGMENT_ASCII_CHARS = 42;

// Profiles whose value-mapping entries are recomputed per call from a
// learned deviceConfig.sdi12ValueCount (task A6, option b). Only these three
// -- all homogeneous seq('vwc', n) layouts -- get this treatment; every
// other profile (including HYDRASCOUT, whose values are NOT homogeneous)
// keeps its static profile.values regardless of any learned count.
var VARIABLE_SEQ_PROFILE_IDS = {
  SENTEK_ENVIROSCAN: true,
  DELTAT_PR2_4: true,
  DELTAT_PR2_6: true
};

var SDI12_ADDRESS_RE = /^[0-9A-Za-z]$/;
var SENTEK_SENSOR_TYPES = { ENVIROSCAN: true, TRISCAN: true };

function invalidLayout(error) {
  return { ok: false, error: error, layout: null, depths: null, hasTriScan: false };
}

function validateSentekLayout(input) {
  var value = input;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return invalidLayout('invalid_json'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidLayout('object_required');
  var topKeys = Object.keys(value).sort().join(',');
  if (topKeys !== 'address,sensors,version') return invalidLayout('unexpected_layout_fields');
  if (value.version !== 1) return invalidLayout('unsupported_version');
  if (typeof value.address !== 'string' || !SDI12_ADDRESS_RE.test(value.address)) return invalidLayout('invalid_address');
  if (!Array.isArray(value.sensors) || value.sensors.length < 1 || value.sensors.length > 10) {
    return invalidLayout('sensor_count');
  }
  var channels = {};
  var positions = {};
  var depthsSeen = {};
  var sensors = [];
  var depths = {};
  var hasTriScan = false;
  for (var i = 0; i < value.sensors.length; i++) {
    var sensor = value.sensors[i];
    if (!sensor || typeof sensor !== 'object' || Array.isArray(sensor)) return invalidLayout('invalid_sensor');
    if (Object.keys(sensor).sort().join(',') !== 'channel,depth_cm,response_position,type') {
      return invalidLayout('unexpected_sensor_fields');
    }
    var channel = sensor.channel;
    var position = sensor.response_position;
    var depth = sensor.depth_cm;
    var type = sensor.type;
    if (!Number.isInteger(channel) || channel < 1 || channel > 10 || channels[channel]) return invalidLayout('invalid_channel');
    if (!Number.isInteger(position) || position < 1 || position > 10 || positions[position]) return invalidLayout('invalid_response_position');
    if (!Number.isInteger(depth) || depth < 1 || depth > 1000 || depthsSeen[depth]) return invalidLayout('invalid_depth');
    if (!SENTEK_SENSOR_TYPES[type]) return invalidLayout('invalid_sensor_type');
    channels[channel] = true;
    positions[position] = true;
    depthsSeen[depth] = true;
    sensors.push({ channel: channel, response_position: position, depth_cm: depth, type: type });
    depths['vwc_' + channel] = depth;
    if (type === 'TRISCAN') {
      depths['soil_vic_' + channel] = depth;
      hasTriScan = true;
    }
  }
  sensors.sort(function (a, b) { return a.response_position - b.response_position; });
  for (var expected = 1; expected <= sensors.length; expected++) {
    if (!positions[expected]) return invalidLayout('non_contiguous_response_positions');
  }
  return {
    ok: true,
    error: null,
    layout: { version: 1, address: value.address, sensors: sensors },
    depths: depths,
    hasTriScan: hasTriScan
  };
}

// Resolve the per-uplink expected reading count: a valid learned
// deviceConfig.sdi12ValueCount takes priority over the profile's own
// expectedValues; an out-of-range learned count (which should never exist
// once the migration CHECK + config-save validation are both in place, but
// normalize() must not trust a value that bypassed both) is treated as if
// nothing were learned, falling back to the profile's expectation.
function resolveCount(profile, deviceConfig) {
  // Fixed-shape profiles (expectedValues != null, e.g. HYDRASCOUT, TENSIOMARK)
  // NEVER honour a learned deviceConfig.sdi12ValueCount, even if one is
  // present (e.g. a stale value left over from switching the device away
  // from a variable profile). Their own expectedValues is the only valid
  // cardinality check -- treating a learned count as authoritative here
  // would quarantine every normal frame the moment the two disagree.
  if (profile && profile.expectedValues != null) {
    return profile.expectedValues;
  }
  var learned = deviceConfig && Number.isInteger(deviceConfig.sdi12ValueCount)
    ? deviceConfig.sdi12ValueCount
    : null;
  var resolved = learned != null ? learned : (profile ? profile.expectedValues : null);
  if (resolved != null && (resolved < 1 || resolved > 8)) {
    resolved = profile ? profile.expectedValues : null;
  }
  return resolved;
}

function worstCaseUplinkBytes(profile) {
  var n = profile.expectedValues == null ? profile.values.length : profile.expectedValues;
  return UPLINK_HEADER_BYTES + n * WORST_CHARS_PER_VALUE;
}

// The field converter split PAYVER=2 data into 42-character ASCII slices.
// Budget against that observed application slice instead of subtracting only
// the five-byte header from the LoRaWAN DR0 envelope: the latter predicted two
// frames for the 90-character Sentek vector that arrived in three.
// k defaults to 1 (today's single-uplink budget, matching worstCaseUplinkBytes
// exactly). This does not change what the fixed-cardinality budget test
// evaluates -- it stays profile.maxUplinks-unaware and still skips variable
// profiles -- it only lets a profile document its multi-segment intent via
// maxUplinks for callers (e.g. the device doc, future config UI) that want
// the k>1 form.
function uplinkBudgetOk(profile) {
  var n = profile.expectedValues == null ? profile.values.length : profile.expectedValues;
  var k = profile.maxUplinks || 1;
  if (k === 1) return UPLINK_HEADER_BYTES + n * WORST_CHARS_PER_VALUE <= 51;
  return n * WORST_CHARS_PER_VALUE <= MULTI_SEGMENT_ASCII_CHARS * k;
}

function seq(prefix, n, opts) {
  var out = [];
  var startIndex = (opts && opts.startIndex) || 0;
  for (var i = 0; i < n; i++) {
    out.push({ index: startIndex + i, channel: prefix + '_' + (i + 1), depthSlot: i + 1 });
  }
  return out;
}

// ALL named profiles ship provisional with identityMatch:null — matchers are
// enabled per probe at the bench, only for identities that uniquely
// determine a value layout (PR2/4 vs PR2/6 share an identity: manual forever).
var PROFILES = [
  {
    id: 'GENERIC_VWC',
    label: 'Generic SDI-12 (VWC per value, in order)',
    provisional: false,
    identityMatch: null,
    expectedValues: null,               // variable: the documented escape hatch
    values: seq('vwc', 8),
    defaultDepthsCm: []
  },
  {
    id: 'SENTEK_ENVIROSCAN',
    label: 'Sentek EnviroSCAN / TriSCAN (configured layout up to 10 modules)',
    // Bench-verified 2026-08-19 on the SDI-12 bench gateway (A8404161D1886837):
    // live aI! = "012SENTEK  XEPI  139D938D7150000" (vendor SENTEK, model XEPI,
    // fw 1.3.9); live aM!/aD0! frame = 5 values, e.g.
    // "+0.000000+0.000000+0.000000+0.104748+0.339201". Calibrated
    // EnviroSCAN values are mm per 10 cm, numerically identical to VWC
    // percent. Layout entries marked TRISCAN use the legacy identity
    // coefficients and are converted from scaled frequency below.
    // Model family per the manual: XPI = EnviroSMART, IPI = EasyAG; XEPI is
    // the EnviroSCAN variant observed live. aM!/aD0! also accepts 1..9 values
    // per measurement command (aM1! for sensors 10-16), consistent with the
    // variable count below. TriSCAN VIC rides aM2!/aM3! after the VWC group.
    provisional: false,
    identityMatch: /\bSENTEK\b.*\b(XEPI|XPI|IPI)\b/i,
    // Variable: no fixed depth count on the wire. Per-device count is learned
    // via devices.sdi12_value_count (task A6, option b) and enforced by
    // resolveCount()/resolvedCount below, not by a static expectedValues here.
    // 8 depths requires AT+DATAUP=1 + AT+PAYVER=2 on the device (multi-segment
    // reassembly shipped; see the 2026-08-19 spec). maxUplinks documents that
    // intent for uplinkBudgetOk()/callers -- the fixed-cardinality budget
    // test above does not evaluate variable profiles either way.
    expectedValues: null,
    // The verified eight-module/two-TriSCAN rail used three slices. Five also
    // covers the supported worst case of ten TriSCAN modules: 20 values at
    // nine ASCII characters each over the observed 42-character slices.
    maxUplinks: 5,
    values: seq('vwc', 8),
    defaultDepthsCm: []
  },
  {
    id: 'DELTAT_PR2_4',
    label: 'Delta-T PR2/4 (VWC, up to 8 depths, variable count)',
    provisional: true,
    identityMatch: null,
    // Variable, same treatment as SENTEK_ENVIROSCAN above -- learned per-device.
    expectedValues: null,
    values: seq('vwc', 8),
    defaultDepthsCm: []
  },
  {
    id: 'DELTAT_PR2_6',
    label: 'Delta-T PR2/6 (VWC, up to 8 depths, variable count)',
    provisional: true,
    identityMatch: null,
    // Variable, same treatment as SENTEK_ENVIROSCAN above -- learned per-device.
    expectedValues: null,
    values: seq('vwc', 8),
    defaultDepthsCm: []
  },
  {
    id: 'TENSIOMARK',
    label: 'ecoTech Tensiomark (tension pF + temp)',
    provisional: true,
    identityMatch: null,
    expectedValues: 2,
    values: [
      { index: 0, channel: 'swt_1', transform: 'pf_to_kpa', depthSlot: 1 },
      { index: 1, channel: 'soil_temp_1', depthSlot: 1 }
    ],
    defaultDepthsCm: [30]
  },
  {
    id: 'IMKO_PICO64',
    label: 'IMKO TRIME PICO 64 (VWC + temp)',
    provisional: true,
    identityMatch: null,
    expectedValues: 2,
    values: [
      { index: 0, channel: 'vwc_1', depthSlot: 1 },
      { index: 1, channel: 'soil_temp_1', depthSlot: 1 }
    ],
    defaultDepthsCm: [30]
  },
  {
    id: 'HYDRASCOUT',
    label: 'HydraScout (VWC + temp + EC, 2 depths in v1)',
    provisional: true,
    identityMatch: null,
    expectedValues: 6,                  // more depths needs AT+DATAUP=1 (phase 2): 8 depths x 3
                                         // channels x 9 chars + 3 > 51-byte DR0 budget (was 7 chars)
    // PROVISIONAL interleave (per-depth vwc,temp,ec) - bench capture decides.
    values: [
      { index: 0, channel: 'vwc_1', depthSlot: 1 },
      { index: 1, channel: 'soil_temp_1', depthSlot: 1 },
      { index: 2, channel: 'soil_ec_1', depthSlot: 1 },
      { index: 3, channel: 'vwc_2', depthSlot: 2 },
      { index: 4, channel: 'soil_temp_2', depthSlot: 2 },
      { index: 5, channel: 'soil_ec_2', depthSlot: 2 }
    ],
    defaultDepthsCm: [15, 30]
  }
];

var BOUNDS = {
  vwc: { min: 0, max: 100 },
  soil_vic: { min: 0 },
  soil_temp: { min: -30, max: 70 },
  soil_ec: { min: 0, max: 100000 }
};

function channelFamily(channel) {
  return channel.replace(/_\d+$/, '');
}

function parseSdi12Values(str) {
  if (typeof str !== 'string' || !VALUE_RE.test(str)) return null;
  var out = [];
  var match = str.match(EXTRACT_RE);
  for (var i = 0; i < match.length; i++) out.push(parseFloat(match[i]));
  return out;
}

function getProfile(id) {
  for (var i = 0; i < PROFILES.length; i++) {
    if (PROFILES[i].id === id) return PROFILES[i];
  }
  return null;
}

function listProfiles() {
  return PROFILES.map(function (p) {
    var slots = [];
    p.values.forEach(function (v) {
      if (v.depthSlot && slots.indexOf(v.depthSlot) === -1) slots.push(v.depthSlot);
    });
    slots.sort(function (a, b) { return a - b; });
    return {
      id: p.id,
      label: p.label,
      provisional: p.provisional,
      expectedValues: p.expectedValues,
      defaultDepthsCm: p.defaultDepthsCm.slice(),
      channels: p.values.map(function (v) { return v.channel; }),
      depthSlots: slots
    };
  });
}

// aI! response: address(1) + sdi12 version(2) + vendor(8) + model(6) + fw(3) + rest.
function parseIdentity(identityString) {
  if (typeof identityString !== 'string' || identityString.length < 17) return null;
  return {
    vendor: identityString.slice(3, 11),
    model: identityString.slice(11, 17),
    firmware: identityString.slice(17, 20)
  };
}

function matchProfile(identityString, profiles) {
  var id = parseIdentity(identityString);
  if (!id) return null;
  var haystack = id.vendor + ' ' + id.model;
  var list = profiles || PROFILES;
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (p.identityMatch && p.identityMatch.test(haystack)) {
      return { profileId: p.id, vendor: id.vendor, model: id.model, firmware: id.firmware };
    }
  }
  return null;
}

function applyValue(entry, raw) {
  var v = raw;
  if (entry.transform) {
    var fn = TRANSFORMS[entry.transform];
    if (!fn) return { error: 'unknown_transform:' + entry.transform };
    v = fn(v);
  }
  if (typeof entry.scale === 'number') v = v * entry.scale;
  if (typeof entry.offset === 'number') v = v + entry.offset;
  if (!Number.isFinite(v)) return { error: 'not_finite' };
  var family = channelFamily(entry.channel);
  if (family === 'swt') {
    // Clamp like resistanceOhmsToKpa (osi-chameleon-helper): [0,300], 2dp.
    v = Math.min(300, Math.max(0, v));
    return { value: Math.round(v * 100) / 100 };
  }
  var bounds = BOUNDS[family];
  if (bounds && ((bounds.min != null && v < bounds.min) || (bounds.max != null && v > bounds.max))) {
    return { error: 'out_of_range' };
  }
  return { value: Math.round(v * 100) / 100 };
}

function normalize(decoded, deviceConfig, meta) {
  var channels = {};
  var unknown = {};
  var noResponse = false;
  var raw = decoded && typeof decoded.data_sum === 'string' ? decoded.data_sum.trim() : '';

  if (decoded && typeof decoded.BatV === 'number') channels.bat_v = decoded.BatV;

  var profileId = deviceConfig && deviceConfig.probeProfile;
  var profile = profileId ? getProfile(profileId) : null;

  if (raw === 'NULL' || raw === '') {
    // Exact NULL or empty match only: probe did not answer. Alive node, no
    // data, never fabricate values. An embedded NULL is garbage, handled below.
    noResponse = true;
  } else if (!profile) {
    unknown.sdi12_unconfigured = raw || '(empty)';
  } else {
    var values = parseSdi12Values(raw);
    var sentekLayout = null;
    if (profile.id === 'SENTEK_ENVIROSCAN' && deviceConfig && deviceConfig.sdi12ChannelLayout != null) {
      sentekLayout = validateSentekLayout(deviceConfig.sdi12ChannelLayout);
    }
    var resolvedCount = sentekLayout && sentekLayout.ok ? null : resolveCount(profile, deviceConfig);
    if (values === null) {
      unknown.unparseable_sdi12 = raw || '(empty)';
    } else if (sentekLayout && !sentekLayout.ok) {
      unknown.sdi12_layout_invalid = sentekLayout.error;
    } else if (sentekLayout && sentekLayout.hasTriScan) {
      var sentekSensors = sentekLayout.layout.sensors;
      var triScanSensors = sentekSensors.filter(function (sensor) { return sensor.type === 'TRISCAN'; });
      var expectedMixedCount = sentekSensors.length + triScanSensors.length;
      if (values.length === sentekSensors.length) {
        // A legacy VWC-only vector does not prove that the salinity command ran.
        // Keep it out of storage rather than relabeling VWC as VIC or accepting
        // a partial mixed sample.
        unknown.sdi12_vic_framing_unverified = raw;
      } else if (values.length !== expectedMixedCount) {
        unknown.sdi12_vic_value_count = raw;
      } else {
        // Production recipe contract: all VWC values in response-position order,
        // followed by the compact M2 salinity group containing TriSCAN modules
        // in that same order. Every command DATACUT strips address + CR/LF.
        var mixedEntries = sentekSensors.map(function (sensor) {
          return {
            index: sensor.response_position - 1,
            channel: 'vwc_' + sensor.channel,
            transform: sensor.type === 'TRISCAN' ? 'sentek_sf_to_vwc' : null
          };
        });
        triScanSensors.forEach(function (sensor, index) {
          mixedEntries.push({ index: sentekSensors.length + index, channel: 'soil_vic_' + sensor.channel });
        });
        var mixedChannels = {};
        var mixedError = null;
        for (var mixedIndex = 0; mixedIndex < mixedEntries.length; mixedIndex++) {
          var mixedEntry = mixedEntries[mixedIndex];
          var mixedResult = applyValue(mixedEntry, values[mixedEntry.index]);
          if (mixedResult.error) {
            mixedError = mixedEntry.channel + ':' + mixedResult.error;
            break;
          }
          mixedChannels[mixedEntry.channel] = mixedResult.value;
        }
        if (mixedError) {
          unknown['sdi12_vic_' + mixedError] = raw;
        } else {
          Object.keys(mixedChannels).forEach(function (channel) {
            channels[channel] = mixedChannels[channel];
          });
        }
      }
    } else if (sentekLayout && values.length !== sentekLayout.layout.sensors.length) {
      unknown.sdi12_layout_value_count = raw;
    } else if (resolvedCount != null && values.length !== resolvedCount) {
      // Cardinality mismatch rejects the frame atomically: a glued address
      // digit or truncated response must never produce a partial write.
      // resolvedCount is either a learned per-device sdi12_value_count or
      // the profile's own fixed expectedValues -- either way, a mismatch
      // here means the frame is wrong, not that the count is variable.
      unknown.sdi12_value_count = raw;
    } else {
      var learnedCount = deviceConfig && Number.isInteger(deviceConfig.sdi12ValueCount)
        && deviceConfig.sdi12ValueCount >= 1 && deviceConfig.sdi12ValueCount <= 8
        ? deviceConfig.sdi12ValueCount
        : null;
      // Only the three homogeneous variable-count profiles remap their
      // channel entries to the learned count; every other profile (notably
      // HYDRASCOUT's non-homogeneous interleave) always uses its static
      // profile.values, unaffected by any learned count.
      var valueEntries;
      if (sentekLayout) {
        valueEntries = sentekLayout.layout.sensors.map(function (sensor) {
          return { index: sensor.response_position - 1, channel: 'vwc_' + sensor.channel };
        });
      } else {
        valueEntries = (learnedCount != null && VARIABLE_SEQ_PROFILE_IDS[profile.id])
          ? seq('vwc', learnedCount)
          : profile.values;
      }
      for (var i = 0; i < valueEntries.length; i++) {
        var entry = valueEntries[i];
        if (entry.index >= values.length) continue;
        var res = applyValue(entry, values[entry.index]);
        if (res.error) {
          unknown[entry.channel + ':' + res.error] = values[entry.index];
        } else {
          channels[entry.channel] = res.value;
        }
      }
    }
  }

  return {
    channels: channels,
    unknown: unknown,
    recordedAt: (meta && meta.recordedAt) || null,
    noResponse: noResponse
  };
}

module.exports = {
  normalize: normalize,
  parseSdi12Values: parseSdi12Values,
  parseIdentity: parseIdentity,
  matchProfile: matchProfile,
  listProfiles: listProfiles,
  getProfile: getProfile,
  worstCaseUplinkBytes: worstCaseUplinkBytes,
  uplinkBudgetOk: uplinkBudgetOk,
  validateSentekLayout: validateSentekLayout,
  TRANSFORMS: TRANSFORMS,
  PROFILES: PROFILES
};
