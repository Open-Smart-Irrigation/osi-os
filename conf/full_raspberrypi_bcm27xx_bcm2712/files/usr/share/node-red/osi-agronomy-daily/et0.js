'use strict';
// FAO-56 reference evapotranspiration (Allen et al. 1998): equation 6 (daily
// Penman-Monteith), 7 (pressure from elevation, inverted for the elevation),
// 47 (wind height), 52 (Hargreaves-Samani), 21-25 (extraterrestrial
// radiation), 28-33 (hourly extraterrestrial radiation), 53 (hourly
// Penman-Monteith, contract v2 A7). Vapour pressure from mean relative humidity, as the cloud's
// WeatherMath does; the Java is the reference and the contract vectors come
// from it (docs/contracts/agronomy/et0-vectors.json). Values in mm/day,
// rounded to 2 decimals.
const GSC = 0.0820;      // MJ m-2 min-1
const SIGMA = 4.903e-9;  // MJ K-4 m-2 day-1
const SIGMA_HOURLY = 4.903e-9 / 24; // MJ K-4 m-2 h-1, written as this expression in every runtime (A7)
const DEFAULT_NIGHT_RS_RSO = 0.5;   // FAO-56 ch. 4: 0.4-0.6 at night in humid and subhumid climates
function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
function round2(v) { return Math.round(v * 100) / 100; }
function satVapourPressure(tC) { return 0.6108 * Math.exp((17.27 * tC) / (tC + 237.3)); }
function validDay(dayOfYear) { return Number.isInteger(dayOfYear) && dayOfYear >= 1 && dayOfYear <= 366; }
function windAt2m(speed, heightM) {
  if (!finite(speed) || speed < 0) return null;
  if (!finite(heightM) || heightM <= 0) return null;
  if (Math.abs(heightM - 2) < 1e-9) return speed;
  // Eq. 47 breaks down below about 0.095 m: the logarithm reaches 0 and turns
  // negative, so such a height gives no wind rather than an absurd one.
  const arg = 67.8 * heightM - 5.42;
  if (!(arg > 1)) return null;
  return speed * 4.87 / Math.log(arg);
}
function extraterrestrialRadiation(latDeg, dayOfYear) {
  const phi = (Math.PI / 180) * latDeg;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI / 365) * dayOfYear);
  const delta = 0.409 * Math.sin((2 * Math.PI / 365) * dayOfYear - 1.39);
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(delta))));
  return (24 * 60 / Math.PI) * GSC * dr * (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
}
// FAO-56 eq. 22-33 for one hour starting at `hourStartMs` (epoch ms): the
// sun's position at mid-hour and the hour's extraterrestrial radiation. Solar
// time from UTC and the longitude (degrees east positive): t_solar = t_utc +
// lon / 15 + Sc (eq. 31-33 with Lz = 0 and Lm = -lon). The hour's end angles
// are clipped to sunrise and sunset (ASCE-EWRI 2005 practice, README), so a
// night hour is 0 and an hour that straddles sunrise or sunset keeps its lit part.
function solarHour(latDeg, dayOfYear, hourStartMs, longitudeDeg) {
  const phi = (Math.PI / 180) * latDeg;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI / 365) * dayOfYear);
  const declination = 0.409 * Math.sin((2 * Math.PI / 365) * dayOfYear - 1.39);
  const omegaS = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(declination))));
  const b = 2 * Math.PI * (dayOfYear - 81) / 364;
  const sc = 0.1645 * Math.sin(2 * b) - 0.1255 * Math.cos(b) - 0.025 * Math.sin(b);
  const midUtcHours = (((hourStartMs / 3600000) + 0.5) % 24 + 24) % 24;
  let omega = (Math.PI / 12) * ((midUtcHours + longitudeDeg / 15 + sc) - 12);
  omega = Math.atan2(Math.sin(omega), Math.cos(omega)); // into (-pi, pi]
  const omega1 = Math.max(-omegaS, Math.min(omegaS, omega - Math.PI / 24));
  const omega2 = Math.max(-omegaS, Math.min(omegaS, omega + Math.PI / 24));
  const ra = omega2 > omega1
    ? Math.max(0, (12 * 60 / Math.PI) * GSC * dr * ((omega2 - omega1) * Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * (Math.sin(omega2) - Math.sin(omega1))))
    : 0;
  return { declination, dr, omegaS, omega, omega1, omega2, ra };
}
// Epoch ms, or an ISO instant with 'Z' or an offset. Date.parse reads a time
// string without a zone as local time, and Java's Instant.parse refuses it, so
// the contract refuses it too (spec A7). Every edge caller passes hourStartIso
// values ('…:00Z') or epoch ms.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
function hourMs(hourStartUtc) {
  if (typeof hourStartUtc === 'number') return hourStartUtc;
  return typeof hourStartUtc === 'string' && ISO_INSTANT.test(hourStartUtc) ? Date.parse(hourStartUtc) : NaN;
}
// A carried night ratio is a clamped day ratio, so anything outside [0.3, 1.0]
// is an input error (spec A7); null and undefined mean "not given".
function badRatio(value) { return value != null && !(finite(value) && value >= 0.3 && value <= 1); }
// MJ m-2 for the hour starting at `hourStartUtc` (an ISO instant or epoch ms).
function hourlyExtraterrestrialRadiation(latDeg, dayOfYear, hourStartUtc, longitudeDeg) {
  const startMs = hourMs(hourStartUtc);
  if (!finite(latDeg) || !finite(longitudeDeg) || !validDay(dayOfYear) || !Number.isFinite(startMs)) return null;
  return solarHour(latDeg, dayOfYear, startMs, longitudeDeg).ra;
}
// Every term of FAO-56 eq. 53 for one hour (contract v2 A7). A day hour (sun
// above the horizon at mid-hour) takes its measured Rs/Rso clamped to
// [0.3, 1.0]; a night hour takes `nightRsRso` ('prior'), else 0.5
// ('default'). The ET0 is signed and not rounded: FAO-56 ch. 11 reads a
// negative hour as net condensation. Null for a missing or out-of-range input.
function fao56HourlyTerms(input) {
  const { tMeanC, rhPct, windSpeedMs, windHeightM, solarRadMjM2h, elevationM, latDeg, lonDeg, dayOfYear, hourStartUtc, nightRsRso } = input || {};
  if (![tMeanC, rhPct, windSpeedMs, solarRadMjM2h, latDeg, lonDeg].every(finite) || !validDay(dayOfYear)) return null;
  if (rhPct < 0 || rhPct > 100 || windSpeedMs < 0 || solarRadMjM2h < 0) return null;
  if (elevationM != null && !finite(elevationM)) return null;
  if (badRatio(nightRsRso)) return null;
  const startMs = hourMs(hourStartUtc);
  if (!Number.isFinite(startMs)) return null;
  const u2 = windAt2m(windSpeedMs, windHeightM);
  if (u2 == null) return null;
  const z = elevationM == null ? 0 : elevationM;
  const pressureKpa = 101.3 * Math.pow((293 - 0.0065 * z) / 293, 5.26);
  const gamma = 0.000665 * pressureKpa;
  const es = satVapourPressure(tMeanC);
  const delta = 4098 * es / Math.pow(tMeanC + 237.3, 2);
  const ea = es * rhPct / 100;
  const sun = solarHour(latDeg, dayOfYear, startMs, lonDeg);
  const sunUp = -sun.omegaS <= sun.omega && sun.omega <= sun.omegaS;
  const rso = Math.max(1e-4, (0.75 + 2e-5 * z) * sun.ra);
  const rns = 0.77 * solarRadMjM2h;
  let rsRso;
  let rsRsoSource;
  if (sunUp) { rsRso = Math.max(0.3, Math.min(1, solarRadMjM2h / rso)); rsRsoSource = 'measured'; }
  else if (finite(nightRsRso)) { rsRso = nightRsRso; rsRsoSource = 'prior'; }
  else { rsRso = DEFAULT_NIGHT_RS_RSO; rsRsoSource = 'default'; }
  // FAO-56 ch. 4 night rule: the hour 2-3 h before sunset.
  const carryCandidate = sunUp && sun.omega >= sun.omegaS - 0.79 && sun.omega <= sun.omegaS - 0.52;
  const rnl = SIGMA_HOURLY * Math.pow(tMeanC + 273.16, 4) * (0.34 - 0.14 * Math.sqrt(ea)) * (1.35 * rsRso - 0.35);
  const rn = rns - rnl;
  const g = sunUp ? 0.1 * rn : 0.5 * rn;
  const denominator = delta + gamma * (1 + 0.34 * u2);
  if (!(denominator > 0)) return null;
  const radTerm = 0.408 * delta * (rn - g) / denominator;
  const aeroTerm = gamma * 37 / (tMeanC + 273) * u2 * (es - ea) / denominator;
  return {
    u2, pressureKpa, gamma, es, delta, ea,
    declination: sun.declination, dr: sun.dr, omegaS: sun.omegaS, omega: sun.omega, omega1: sun.omega1, omega2: sun.omega2, ra: sun.ra,
    rso, rns, rsRso, rnl, rn, g, radTerm, aeroTerm, et0Mm: radTerm + aeroTerm,
    sunUp, rsRsoSource, carryCandidate,
  };
}
function fao56Et0Hourly(input) {
  const terms = fao56HourlyTerms(input);
  return terms ? terms.et0Mm : null;
}
// One local day as the sum of its signed hours, clamped at 0 once and rounded
// to 2 decimals (ruling R3). `hours` is every hour of the day in time order,
// { hourStartUtc, tMeanC, rhPct, windSpeedMs, solarRadMjM2h }; a null hour, a
// null field or a failed hour makes the day null, so the caller decides
// completeness first. Night hours take the ratio of the day's carry hour, else
// `priorRsRso`, else 0.5 (the FAO-56 ch. 4 night rule).
function fao56Et0HourlyDay({ hours, windHeightM, elevationM, latDeg, lonDeg, dayOfYear, priorRsRso } = {}) {
  if (!Array.isArray(hours) || !hours.length || badRatio(priorRsRso)) return null;
  let carried = finite(priorRsRso) ? priorRsRso : DEFAULT_NIGHT_RS_RSO;
  let carriedSource = finite(priorRsRso) ? 'prior' : 'default';
  let sumMm = 0;
  const hourly = [];
  for (const hour of hours) {
    if (!hour || hour.hourStartUtc == null || [hour.tMeanC, hour.rhPct, hour.windSpeedMs, hour.solarRadMjM2h].some((v) => v == null)) return null;
    const terms = fao56HourlyTerms({ ...hour, windHeightM, elevationM, latDeg, lonDeg, dayOfYear, nightRsRso: carried });
    if (!terms) return null;
    const rsRsoSource = terms.sunUp ? 'measured' : carriedSource;
    if (terms.carryCandidate) { carried = terms.rsRso; carriedSource = 'carried'; }
    sumMm += terms.et0Mm;
    hourly.push({ hourStartUtc: hour.hourStartUtc, et0Mm: terms.et0Mm, sunUp: terms.sunUp, rsRsoSource });
  }
  return { et0Mm: round2(Math.max(0, sumMm)), sumMm, lastRsRso: carried, hourly };
}
function fao56Et0(input) {
  const { tMinC, tMaxC, meanRhPct, windSpeedMs, windHeightM, solarRadMjM2, elevationM, latDeg, dayOfYear } = input || {};
  if (![tMinC, tMaxC, meanRhPct, windSpeedMs, solarRadMjM2, latDeg].every(finite) || !validDay(dayOfYear)) return null;
  if (tMaxC < tMinC || meanRhPct < 0 || meanRhPct > 100 || windSpeedMs < 0 || solarRadMjM2 < 0) return null;
  if (elevationM != null && !finite(elevationM)) return null;
  const u2 = windAt2m(windSpeedMs, windHeightM);
  if (u2 == null) return null;
  const z = elevationM == null ? 0 : elevationM;
  const tMean = (tMaxC + tMinC) / 2;
  const slope = 4098 * satVapourPressure(tMean) / Math.pow(tMean + 237.3, 2);
  const pressure = 101.3 * Math.pow((293 - 0.0065 * z) / 293, 5.26);
  const gamma = 0.000665 * pressure;
  const es = (satVapourPressure(tMaxC) + satVapourPressure(tMinC)) / 2;
  const ea = es * meanRhPct / 100;
  const vpd = Math.max(0, es - ea);
  const ra = extraterrestrialRadiation(latDeg, dayOfYear);
  const rso = Math.max(1e-4, (0.75 + 2e-5 * z) * ra);
  const ratio = Math.max(0.3, Math.min(1, solarRadMjM2 / rso));
  const rns = 0.77 * solarRadMjM2;
  const rnl = SIGMA * ((Math.pow(tMaxC + 273.16, 4) + Math.pow(tMinC + 273.16, 4)) / 2) * (0.34 - 0.14 * Math.sqrt(Math.max(0, ea))) * (1.35 * ratio - 0.35);
  const rn = rns - rnl;
  const numerator = 0.408 * slope * rn + gamma * (900 / (tMean + 273)) * u2 * vpd;
  const denominator = slope + gamma * (1 + 0.34 * u2);
  if (!(denominator > 0)) return null;
  return round2(Math.max(0, numerator / denominator));
}
function hargreavesEt0(input) {
  const { tMinC, tMaxC, latDeg, dayOfYear } = input || {};
  if (![tMinC, tMaxC, latDeg].every(finite) || !validDay(dayOfYear) || tMaxC < tMinC) return null;
  const raMm = 0.408 * extraterrestrialRadiation(latDeg, dayOfYear);
  return round2(Math.max(0, 0.0023 * ((tMaxC + tMinC) / 2 + 17.8) * Math.sqrt(tMaxC - tMinC) * raMm));
}
function luxToWm2(lux, luxPerWm2) { return finite(lux) && finite(luxPerWm2) && luxPerWm2 > 0 ? lux / luxPerWm2 : null; }
function wm2HoursToMjPerDay(values) { return values.reduce((s, v) => s + (finite(v) ? v : 0), 0) * 3600 / 1e6; }
// FAO-56 eq. 7 solved for z: z = (293 / 0.0065) × (1 − (P / 101.3)^(1/5.26)).
function elevationFromPressure(pressureKpa) {
  if (!finite(pressureKpa) || pressureKpa <= 0) return null;
  return (293 / 0.0065) * (1 - Math.pow(pressureKpa / 101.3, 1 / 5.26));
}
module.exports = { fao56Et0, hargreavesEt0, windAt2m, luxToWm2, wm2HoursToMjPerDay, extraterrestrialRadiation, hourlyExtraterrestrialRadiation, elevationFromPressure, fao56HourlyTerms, fao56Et0Hourly, fao56Et0HourlyDay };
