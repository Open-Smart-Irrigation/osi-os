// Pure port of osi-watermark-helper/conversion.js (wm-lsn50-p3-v2), used by
// the public simulator with deterministic fictional ADC frames.
export type WatermarkCalibrationValues = Record<string, number>;

export function convertWatermarkChannel(fwd: number, rev: number, tempC: number, calibration: WatermarkCalibrationValues, channel: number) {
  const pullup = Number(calibration[`pullup_${channel}_ohm`]);
  const pulldown = Number(calibration[`pulldown_${channel}_ohm`]);
  const seriesFwd = Number(calibration[`series_fwd_${channel}_ohm`]);
  const seriesRev = Number(calibration[`series_rev_${channel}_ohm`]);
  if (![pullup, pulldown, seriesFwd, seriesRev].every(Number.isFinite) || pullup < 25000 || pullup > 65000 || pulldown < 25000 || pulldown > 65000 || seriesFwd < 0 || seriesFwd > 500 || seriesRev < 0 || seriesRev > 500) {
    return {r_fwd: null, r_rev: null, r_solved: null, r_upper_bound: null, kpa: null, kpa_upper_bound: null, offset_mv: null, status: 'calibration_required'};
  }
  const xf = fwd / 4095, xr = rev / 4095;
  const af = (1 - xf) / pullup, ar = xr / pulldown;
  const resistance = (xf + 1 - xr - af * seriesFwd - ar * seriesRev) / (af + ar);
  const rFwd = xf < 1 ? pullup * xf / (1 - xf) - seriesFwd : null;
  const rRev = xr > 0 ? pulldown * (1 - xr) / xr - seriesRev : null;
  const offset = xf - af * (resistance + seriesFwd);
  if (!Number.isFinite(resistance) || tempC < 0 || tempC > 50) return {r_fwd: rFwd, r_rev: rRev, r_solved: null,
    r_upper_bound: null, kpa: null, kpa_upper_bound: null, offset_mv: Number.isFinite(offset) ? offset * 3300 : null,
    status: tempC < 0 || tempC > 50 ? 'temperature_out_of_range' : 'invalid_sample'};
  const td = 1 + 0.018 * (tempC - 24), r = resistance / 1000;
  const kpa = resistance <= 1000 ? (23.156 * r - 12.736) * td : resistance <= 8000
    ? (3.213 * r + 4.093) / (1 - 0.009733 * r - 0.01205 * tempC)
    : 2.246 + 5.239 * r * td + 0.06756 * r * r * td * td;
  const status = resistance < 300 ? 'short' : resistance <= 550 ? 'saturated' : kpa >= 0 && kpa <= 200 ? 'ok' : 'outside_200ss_range';
  return {r_fwd: rFwd, r_rev: rRev, r_solved: Math.round(resistance), r_upper_bound: null,
    kpa: status === 'ok' ? Math.round(kpa * 10) / 10 : status === 'saturated' ? 0 : null,
    kpa_upper_bound: null, offset_mv: offset * 3300, status};
}
