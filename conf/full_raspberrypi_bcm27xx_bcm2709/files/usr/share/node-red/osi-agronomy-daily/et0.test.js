'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const et0 = require('./et0');
const REPO = path.resolve(__dirname, '../../../../../../..');
const vectors = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/contracts/agronomy/et0-vectors.json'), 'utf8'));
const near = (got, want) => (want == null ? got === null : Math.abs(got - want) <= 0.005);

test('fao56Et0 reproduces every contract vector, including the dark days where Rs/Rso < 0.3', () => {
  for (const v of [...vectors.fao56, ...vectors.fao56Rejects]) assert.ok(near(et0.fao56Et0(v.input), v.et0Mm), v.name + ': expected ' + v.et0Mm + ' got ' + et0.fao56Et0(v.input));
  const byName = Object.fromEntries(vectors.fao56.map((v) => [v.name, v.et0Mm]));
  assert.equal(byName.brussels_example_18, 3.79);
  assert.equal(byName.payerne_winter_rs_1, 0.27);
  assert.equal(byName.payerne_winter_rs_0, 0.17);
  assert.equal(byName.lat70_doy355_rs_0, 0.25);
  assert.equal(byName.rh_100_wind_0, 5.07);
});

test('hargreavesEt0 reproduces every contract vector and checks the day of year', () => {
  for (const v of vectors.hargreaves) assert.ok(near(et0.hargreavesEt0(v.input), v.et0Mm), v.name);
  assert.equal(et0.hargreavesEt0({ tMinC: 10, tMaxC: 20, latDeg: 46.8, dayOfYear: 0 }), null);
  assert.equal(et0.hargreavesEt0({ tMinC: 10, tMaxC: 20, latDeg: 46.8, dayOfYear: 367 }), null);
  assert.equal(et0.hargreavesEt0({ tMinC: 20, tMaxC: 10, latDeg: 46.8, dayOfYear: 200 }), null);
});

test('windAt2m: FAO-56 eq. 47, null for a missing or non-positive height', () => {
  assert.ok(Math.abs(et0.windAt2m(3.4, 10) - 2.543) < 0.001);
  assert.equal(et0.windAt2m(2.78, 2), 2.78);
  assert.equal(et0.windAt2m(2.78, null), null);
  assert.equal(et0.windAt2m(2.78, undefined), null);
  assert.equal(et0.windAt2m(2.78, 0), null);
  assert.equal(et0.windAt2m(-1, 2), null);
});

test('elevation is null-tolerant but a non-finite elevation is rejected, as in the Java', () => {
  const base = vectors.fao56.find((v) => v.name === 'payerne_summer').input;
  assert.equal(et0.fao56Et0({ ...base, elevationM: null }), vectors.fao56.find((v) => v.name === 'null_elevation').et0Mm);
  assert.equal(et0.fao56Et0({ ...base, elevationM: NaN }), null);
  assert.equal(et0.fao56Et0({ ...base, elevationM: Infinity }), null);
  assert.equal(et0.fao56Et0({ ...base, dayOfYear: 200.5 }), null);
});

test('lux, radiation sums and pressure elevation', () => {
  assert.equal(et0.luxToWm2(120, 120), 1);
  assert.equal(et0.luxToWm2(null, 120), null);
  assert.equal(et0.wm2HoursToMjPerDay([500, 500]), 3.6);
  for (const v of vectors.luxToRadiation) assert.ok(Math.abs(et0.luxToWm2(v.lux, 120) - v.wm2) <= 0.01);
  for (const v of vectors.elevationFromPressure) assert.ok(Math.abs(et0.elevationFromPressure(v.pressureKpa) - v.elevationM) <= 0.05, String(v.pressureKpa));
  assert.equal(et0.elevationFromPressure(null), null);
  assert.equal(et0.elevationFromPressure(0), null);
});

test('windAt2m: a height where eq. 47 breaks down (67.8 h - 5.42 <= 1) gives no wind', () => {
  assert.equal(et0.windAt2m(3, 0.09), null);
  assert.equal(et0.windAt2m(3, (1 + 5.42) / 67.8), null);
  assert.ok(et0.windAt2m(3, 0.2) > 0);
});

test('hourlyExtraterrestrialRadiation: eq. 28 hours sum to the daily Ra, night is 0, bad input is null', () => {
  const sumDay = (lat, doy, dayStartMs, lon) => {
    let s = 0;
    for (let h = 0; h < 24; h += 1) s += et0.hourlyExtraterrestrialRadiation(lat, doy, dayStartMs + h * 3600000, lon);
    return s;
  };
  for (const [lat, doy, start, lon] of [[46.8, 268, Date.UTC(2026, 8, 25), 6.95], [0.33, 268, Date.UTC(2026, 8, 25), 32.58], [-33.9, 172, Date.UTC(2026, 5, 21), 18.4]]) {
    const daily = et0.extraterrestrialRadiation(lat, doy);
    assert.ok(Math.abs(sumDay(lat, doy, start, lon) - daily) / daily < 0.01, `${lat}/${doy}`);
  }
  // Payerne, 25 Sep: solar noon near 11:25 UTC; 11:00-12:00 UTC is the peak hour, 22:00 UTC is night.
  const noon = et0.hourlyExtraterrestrialRadiation(46.8, 268, '2026-09-25T11:00:00Z', 6.95);
  assert.ok(noon > 3.1 && noon < 3.3, String(noon));
  assert.equal(et0.hourlyExtraterrestrialRadiation(46.8, 268, '2026-09-25T22:00:00Z', 6.95), 0);
  assert.ok(et0.hourlyExtraterrestrialRadiation(46.8, 268, '2026-09-25T06:00:00Z', 6.95) < 1, 'the first light hour');
  assert.equal(et0.hourlyExtraterrestrialRadiation(46.8, 268, 'not a time', 6.95), null);
  assert.equal(et0.hourlyExtraterrestrialRadiation(46.8, 268, '2026-09-25T11:00:00Z', null), null);
});

// Contract v2, hourly FAO-56 Penman-Monteith (spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, A7-A9).
const termTolerance = (v, name) => (v.termTolerance ? (v.termTolerance[name] ?? v.termTolerance.default) : v.tolerance);

test('fao56HourlyTerms reproduces FAO-56 Example 19 and the computed hours within their tolerances', () => {
  assert.equal(vectors.fao56Hourly.length, 5);
  for (const v of vectors.fao56Hourly) {
    const terms = et0.fao56HourlyTerms(v.input);
    assert.ok(terms, v.name);
    assert.ok(Math.abs(terms.et0Mm - v.et0Mm) <= v.tolerance, `${v.name}: et0 ${terms.et0Mm}`);
    assert.equal(et0.fao56Et0Hourly(v.input), terms.et0Mm, v.name);
    for (const [name, want] of Object.entries(v.terms || {})) {
      assert.ok(Math.abs(terms[name] - want) <= termTolerance(v, name), `${v.name}.${name}: ${terms[name]} vs ${want}`);
    }
  }
  const byName = Object.fromEntries(vectors.fao56Hourly.map((v) => [v.name, et0.fao56Et0Hourly(v.input)]));
  assert.ok(Math.abs(byName.fao56_example19_1400_1500 - 0.63) <= 0.005);
  assert.ok(Math.abs(byName.fao56_example19_0200_0300) <= 0.005);
  assert.ok(Math.abs(byName.payerne_summer_noon_10m - byName.payerne_summer_noon) <= 1e-5, 'the 10 m wind equals the 2 m case');
  assert.ok(byName.payerne_winter_night < 0 && Math.abs(byName.payerne_winter_night + 0.0021) <= 1e-4, 'the winter night hour stays signed');
});

test('fao56Et0HourlyDay reproduces the synthetic Payerne day hour by hour; the 16:00 UTC hour carries its ratio to the evening', () => {
  const [v] = vectors.fao56HourlyDays;
  const day = et0.fao56Et0HourlyDay(v.input);
  assert.ok(Math.abs(day.sumMm - v.sumMm) <= 1e-4);
  assert.equal(day.et0Mm, 4.85);
  assert.equal(day.et0Mm, v.et0Mm);
  assert.ok(Math.abs(day.lastRsRso - v.lastRsRso) <= 1e-4);
  assert.equal(day.hourly.length, 24);
  day.hourly.forEach((h, i) => {
    const want = v.hourly[i];
    assert.equal(h.hourStartUtc, want.hourStartUtc);
    assert.ok(Math.abs(h.et0Mm - want.et0Mm) <= 1e-4, want.hourStartUtc);
    assert.deepEqual([h.sunUp, h.rsRsoSource], [want.sunUp, want.rsRsoSource], want.hourStartUtc);
  });
  const sources = day.hourly.map((h) => h.rsRsoSource);
  assert.deepEqual(sources.slice(0, 6), Array(6).fill('default'), 'no carry hour yet: 0.5');
  assert.equal(day.hourly[6].hourStartUtc, '2026-07-19T04:00:00Z');
  assert.equal(day.hourly[6].sunUp, true, 'sunrise at 4.05 UTC: the 04:00 hour is the first day hour');
  const carries = v.input.hours.filter((h) => et0.fao56HourlyTerms({ ...h, windHeightM: 2, elevationM: 490, latDeg: 46.8, lonDeg: 6.95, dayOfYear: 200 }).carryCandidate);
  assert.deepEqual(carries.map((h) => h.hourStartUtc), ['2026-07-19T16:00:00Z']);
  const straddle = et0.fao56HourlyTerms({ ...v.input.hours[21], windHeightM: 2, elevationM: 490, latDeg: 46.8, lonDeg: 6.95, dayOfYear: 200, nightRsRso: 0.79 });
  assert.deepEqual([straddle.sunUp, straddle.ra > 0, straddle.g / straddle.rn], [false, true, 0.5], 'the hour across sunset takes the night rules with Ra above 0');
  assert.deepEqual(sources.slice(21), ['carried', 'carried', 'carried']);
});

test('fao56Et0HourlyDay: priorRsRso before the first carry hour, a negative day is 0, one missing field voids the day', () => {
  const hour = { hourStartUtc: '2026-07-18T22:00:00Z', tMeanC: 15, rhPct: 80, windSpeedMs: 2, solarRadMjM2h: 0 };
  const site = { windHeightM: 2, elevationM: 490, latDeg: 46.8, lonDeg: 6.95, dayOfYear: 200 };
  const prior = et0.fao56Et0HourlyDay({ ...site, hours: [hour], priorRsRso: 0.7 });
  assert.deepEqual([prior.hourly[0].rsRsoSource, prior.lastRsRso], ['prior', 0.7]);
  const fallback = et0.fao56Et0HourlyDay({ ...site, hours: [hour], priorRsRso: null });
  assert.deepEqual([fallback.hourly[0].rsRsoSource, fallback.lastRsRso], ['default', 0.5]);
  // A saturated winter day at Payerne without sun: every hour loses longwave radiation.
  const winter = Array.from({ length: 24 }, (_, h) => ({ hourStartUtc: new Date(Date.parse('2026-12-20T23:00:00Z') + h * 3600000).toISOString(), tMeanC: 1, rhPct: 100, windSpeedMs: 1, solarRadMjM2h: 0 }));
  const negative = et0.fao56Et0HourlyDay({ ...site, dayOfYear: 355, hours: winter, priorRsRso: null });
  assert.ok(negative.sumMm < 0, String(negative.sumMm));
  assert.equal(negative.et0Mm, 0);
  assert.equal(et0.fao56Et0HourlyDay({ ...site, hours: [hour, { ...hour, hourStartUtc: '2026-07-18T23:00:00Z', tMeanC: null }] }), null);
  assert.equal(et0.fao56Et0HourlyDay({ ...site, hours: [hour, null] }), null);
  assert.equal(et0.fao56Et0HourlyDay({ ...site, hours: [] }), null);
  // A carried ratio is a clamped day ratio: outside [0.3, 1.0] it is an input error (spec A7).
  assert.equal(et0.fao56Et0HourlyDay({ ...site, hours: [hour], priorRsRso: 0.29 }), null);
  assert.equal(et0.fao56Et0HourlyDay({ ...site, hours: [hour], priorRsRso: 1.2 }), null);
  assert.equal(et0.fao56Et0HourlyDay({ ...site, hours: [hour], priorRsRso: 0.3 }).lastRsRso, 0.3);
});

test('fao56HourlyTerms null rules and the standalone night ratio', () => {
  const base = vectors.fao56Hourly.find((v) => v.name === 'payerne_summer_noon').input;
  assert.ok(et0.fao56HourlyTerms(base));
  for (const [field, value] of [['tMeanC', null], ['rhPct', 101], ['rhPct', -1], ['windSpeedMs', -0.1], ['solarRadMjM2h', -0.1], ['latDeg', null], ['lonDeg', undefined], ['dayOfYear', 0], ['dayOfYear', 367], ['hourStartUtc', 'not a time'], ['hourStartUtc', '2026-07-19T11:00:00'], ['nightRsRso', 0.2], ['nightRsRso', 1.01], ['nightRsRso', 'x'], ['windHeightM', null], ['windHeightM', 0.09], ['elevationM', NaN]]) {
    assert.equal(et0.fao56HourlyTerms({ ...base, [field]: value }), null, `${field}=${value}`);
  }
  assert.ok(et0.fao56HourlyTerms({ ...base, elevationM: null }), 'a null elevation is 0 m');
  const night = vectors.fao56Hourly.find((v) => v.name === 'payerne_winter_night').input;
  assert.equal(et0.fao56HourlyTerms({ ...night, nightRsRso: null }).rsRsoSource, 'default');
  assert.equal(et0.fao56HourlyTerms({ ...night, nightRsRso: null }).rsRso, 0.5);
  assert.equal(et0.fao56HourlyTerms({ ...night, nightRsRso: 0.8 }).rsRsoSource, 'prior');
  assert.equal(et0.fao56HourlyTerms({ ...base, hourStartUtc: Date.parse(base.hourStartUtc) }).et0Mm, et0.fao56HourlyTerms(base).et0Mm, 'epoch ms or ISO');
  assert.equal(et0.fao56HourlyTerms({ ...base, hourStartUtc: '2026-07-19T13:00:00+02:00' }).et0Mm, et0.fao56HourlyTerms(base).et0Mm, 'an offset names the same instant');
});
