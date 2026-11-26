import {DAY_MS, SLICE_END, SLICE_START, localDayStart} from '../src/core/time';
import {Weather, rainInDay} from '../src/core/weather';

export function seedTraits(seed: number) {
  const weather = new Weather(seed);
  const first = weather.actual(SLICE_START);
  const rainBeforeRegistration = rainInDay(first, localDayStart(SLICE_START), SLICE_START);
  let dryStreak = 0;
  let longestDryStreak = 0;
  let wetDays = 0;
  let maxRainMm = 0;
  for (let at = localDayStart(SLICE_START); at < localDayStart(SLICE_END); at += DAY_MS) {
    const day = weather.actual(at);
    dryStreak = day.wet ? 0 : dryStreak + 1;
    wetDays += Number(day.wet);
    longestDryStreak = Math.max(longestDryStreak, dryStreak);
    maxRainMm = Math.max(maxRainMm, day.rainMm);
  }
  return {seed, rainBeforeRegistration, wetDays, longestDryStreak, maxRainMm};
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const matches: Record<string, ReturnType<typeof seedTraits>> = {};
  for (let seed = 1; Object.keys(matches).length < 3; seed++) {
    const traits = seedTraits(seed);
    if (traits.rainBeforeRegistration > 0) continue;
    if (traits.maxRainMm >= 15) matches.storm ??= traits;
    else if (traits.longestDryStreak >= 7) matches['dry-spell'] ??= traits;
    else if (traits.wetDays >= 2) matches.baseline ??= traits;
  }
  console.log(JSON.stringify(matches, null, 2));
}
