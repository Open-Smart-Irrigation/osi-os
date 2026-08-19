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
  hpa_to_kpa: function (v) { return v / 10; }
};

// Budget assumption: 3 header bytes + worst-case 9 ASCII chars per value
// (sign + 8; bench-measured against real Sentek value widths, e.g.
// "+123.456" plus a sign/margin digit -- corrected from the original
// datasheet-derived 7).
// Dragino delivers at most 51 bytes per FPort 2 uplink at DR0; oversized
// frames are dropped by the device. Fixed-cardinality profiles must fit.
var UPLINK_HEADER_BYTES = 3;
var WORST_CHARS_PER_VALUE = 9;

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
    label: 'Sentek EnviroSCAN (VWC, up to 8 depths, variable count)',
    // Bench-verified 2026-08-19 on agrolink-test-01 (A8404161D1886837):
    // live aI! = "012SENTEK  XEPI  139D938D7150000" (vendor SENTEK, model XEPI,
    // fw 1.3.9); live aM!/aD0! frame = 5 values, e.g.
    // "+0.000000+0.000000+0.000000+0.104748+0.339201". Unit per the Sentek
    // SDI-12 Probe Interface Manual v3.4: volumetric water content in
    // mm per 10 cm of soil -- numerically identical to VWC-percent
    // (1 mm / 100 mm = 1 %), so values map to vwc_N with NO scaling.
    // Model family per the manual: XPI = EnviroSMART, IPI = EasyAG; XEPI is
    // the EnviroSCAN variant observed live. aM!/aD0! also accepts 1..9 values
    // per measurement command (aM1! for sensors 10-16), consistent with the
    // variable count below. Salinity rides aM2!/aM3! (separate recipe slot,
    // not mapped in v1).
    provisional: false,
    identityMatch: /\bSENTEK\b.*\b(XEPI|XPI|IPI)\b/i,
    // Variable: no fixed depth count on the wire. Per-device count is learned
    // via devices.sdi12_value_count (task A6, option b) and enforced by
    // resolveCount()/resolvedCount below, not by a static expectedValues here.
    // 8 depths needs AT+DATAUP=1 (phase 2): 8*9+3 > 51-byte DR0 budget either
    // way -- the phase-2 gating note stays valid with the corrected constant.
    expectedValues: null,
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
  var family = channelFamily(entry.channel);
  if (family === 'swt') {
    // Clamp like resistanceOhmsToKpa (osi-chameleon-helper): [0,300], 2dp.
    v = Math.min(300, Math.max(0, v));
    return { value: Math.round(v * 100) / 100 };
  }
  var bounds = BOUNDS[family];
  if (bounds && (v < bounds.min || v > bounds.max)) {
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
    var resolvedCount = resolveCount(profile, deviceConfig);
    if (values === null) {
      unknown.unparseable_sdi12 = raw || '(empty)';
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
      var valueEntries = (learnedCount != null && VARIABLE_SEQ_PROFILE_IDS[profile.id])
        ? seq('vwc', learnedCount)
        : profile.values;
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
  TRANSFORMS: TRANSFORMS,
  PROFILES: PROFILES
};
