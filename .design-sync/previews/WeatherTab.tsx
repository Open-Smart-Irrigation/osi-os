import React from 'react';
import { WeatherTab } from 'open-smart-irrigation';

// WeatherTab is pure props (online / forecast / location) — no fetch.
// Fixtures follow OnlineEnvironment + ForecastEnvironment from
// types/farming.ts; hourly timestamps must fall inside now+24h or the chart
// filters them out.
const now = Date.now();
const iso = (msFromNow: number) => new Date(now + msFromNow).toISOString();
const dayIso = (d: number) => new Date(now + d * 86_400_000).toISOString().slice(0, 10);

const location = (source: 'zone' | 'gateway' | 'unavailable') => ({
  latitude: source === 'unavailable' ? null : 46.94,
  longitude: source === 'unavailable' ? null : 7.44,
  timezone: 'Europe/Zurich',
  source,
}) as any;

const online = (current: Record<string, unknown> | null) => ({
  available: current != null,
  source: current != null ? 'open_meteo' : 'unavailable',
  cacheStatus: current != null ? 'live' : 'miss',
  observedAt: current != null ? iso(-8 * 60_000) : null,
  expiresAt: current != null ? iso(22 * 60_000) : null,
  current,
}) as any;

const daily = (d: number, code: number, desc: string, hi: number, lo: number, rain: number, prob: number) => ({
  date: dayIso(d), description: desc, weatherCode: code,
  maxTempC: hi, minTempC: lo, rainMm: rain, rainProbabilityPct: prob,
  windSpeedMps: 3.2, et0MmDay: 4.1, etcMmDay: 3.4,
});

const hourly = (h: number, rain: number, prob: number, temp: number) => ({
  time: iso(h * 3600_000), rainMm: rain, rainProbabilityPct: prob,
  tempC: temp, windSpeedMps: 2.9,
});

const forecast = (rainFocus: Record<string, unknown> | null) => ({
  available: rainFocus != null,
  source: rainFocus != null ? 'open_meteo' : 'unavailable',
  cacheStatus: rainFocus != null ? 'live' : 'miss',
  observedAt: rainFocus != null ? iso(-12 * 60_000) : null,
  expiresAt: rainFocus != null ? iso(48 * 60_000) : null,
  rainFocus,
}) as any;

const W = { maxWidth: 700 };

// Front moving in: overcast now, rain starting in ~6 h, wet 24/72 h totals,
// highlighted pills, mixed daily strip, rain bars + probability line.
export function RainApproaching() {
  const rf = {
    totalNext24hMm: 12.4,
    totalNext72hMm: 28.6,
    maxHourlyRainMm: 3.8,
    maxHourlyRainAt: iso(9 * 3600_000),
    nextRainEta: iso(6 * 3600_000),
    rainHoursNext24h: 9,
    daily: [
      daily(0, 3, 'Overcast', 21.4, 12.8, 6.2, 75),
      daily(1, 63, 'Moderate rain', 17.9, 11.5, 14.8, 90),
      daily(2, 61, 'Light rain', 19.2, 12.1, 7.6, 65),
      daily(3, 2, 'Partly cloudy', 23.5, 13.4, 0.4, 25),
      daily(4, 1, 'Mainly clear', 26.1, 14.2, 0, 5),
      daily(5, 0, 'Clear sky', 27.8, 15.0, 0, 0),
      daily(6, 2, 'Partly cloudy', 26.4, 15.8, 1.2, 30),
    ],
    hourly: Array.from({ length: 23 }, (_, i) => {
      const h = i + 1;
      const rain = h < 6 ? 0 : h < 10 ? +(0.8 * (h - 5)).toFixed(1) : h < 16 ? 1.6 : 0.4;
      const prob = h < 6 ? 15 + h * 5 : h < 16 ? 85 : 55;
      return hourly(h, rain, prob, 18 - h * 0.2);
    }),
  };
  return (
    <div style={W}>
      <WeatherTab
        online={online({
          description: 'Overcast', weatherCode: 3, airTemperatureC: 18.6,
          relativeHumidityPct: 78, pressureHpa: 1009, windSpeedMps: 4.6,
          windDirectionDeg: 245, cloudCoverPct: 95, rainMm: 0,
          precipitationProbabilityPct: 60,
        })}
        forecast={forecast(rf)}
        location={location('zone')}
      />
    </div>
  );
}

// July heatwave: sunny and hot, no rain anywhere in the window — pills
// unhighlighted, "next rain" em-dash, all-sun daily strip, flat chart.
export function DryHeatwave() {
  const rf = {
    totalNext24hMm: 0,
    totalNext72hMm: 0,
    maxHourlyRainMm: 0,
    maxHourlyRainAt: null,
    nextRainEta: null,
    rainHoursNext24h: 0,
    daily: [
      daily(0, 0, 'Clear sky', 33.4, 19.2, 0, 0),
      daily(1, 0, 'Clear sky', 34.8, 20.1, 0, 0),
      daily(2, 1, 'Mainly clear', 35.2, 21.0, 0, 5),
      daily(3, 0, 'Clear sky', 34.1, 20.6, 0, 0),
      daily(4, 2, 'Partly cloudy', 32.6, 19.8, 0, 10),
      daily(5, 0, 'Clear sky', 33.0, 19.4, 0, 0),
      daily(6, 0, 'Clear sky', 33.8, 19.9, 0, 0),
    ],
    hourly: Array.from({ length: 23 }, (_, i) => hourly(i + 1, 0, i < 12 ? 0 : 5, 26 + (i < 10 ? i * 0.7 : (22 - i) * 0.5))),
  };
  return (
    <div style={W}>
      <WeatherTab
        online={online({
          description: 'Clear sky', weatherCode: 0, airTemperatureC: 32.7,
          relativeHumidityPct: 34, pressureHpa: 1021, windSpeedMps: 1.8,
          windDirectionDeg: 90, cloudCoverPct: 2, rainMm: 0,
          precipitationProbabilityPct: 0,
        })}
        forecast={forecast(rf)}
        location={location('zone')}
      />
    </div>
  );
}

// Forecast provider down but current conditions cached: only the conditions
// bar renders — no pills, strip, or chart.
export function CurrentConditionsOnly() {
  return (
    <div style={W}>
      <WeatherTab
        online={online({
          description: 'Light drizzle', weatherCode: 51, airTemperatureC: 14.2,
          relativeHumidityPct: 88, pressureHpa: 1004, windSpeedMps: 5.4,
          windDirectionDeg: 310, cloudCoverPct: 100, rainMm: 0.3,
          precipitationProbabilityPct: 70,
        })}
        forecast={forecast(null)}
        location={location('gateway')}
      />
    </div>
  );
}

// Zone has no coordinates: the empty state asks the user to set them.
export function NoLocation() {
  return (
    <div style={W}>
      <WeatherTab
        online={online(null)}
        forecast={forecast(null)}
        location={location('unavailable')}
      />
    </div>
  );
}
