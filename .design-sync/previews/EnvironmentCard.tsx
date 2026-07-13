import React from 'react';
import { EnvironmentCard } from 'open-smart-irrigation';

// EnvironmentCard fetches /api/irrigation-zones/<id>/environment-summary.
// Zone 12 uses the shim's default fixture (full water balance — the canonical
// story). Zones 21/22 get shape-complete custom summaries: WaterTab maps
// water.daily before its guards, so every array must be present.
const nowIso = () => new Date().toISOString();
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const dayIso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

const waterDay = (daysAgo: number, rainMm: number, liters: number) => ({
  date: new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10),
  rainMm, irrigationLiters: liters,
  irrigationNetMm: liters > 0 ? +(liters * 0.85 / 1450).toFixed(2) : 0,
  measuredIrrigationLiters: liters, estimatedIrrigationLiters: liters,
  measuredIrrigationNetMm: liters > 0 ? +(liters * 0.85 / 1450).toFixed(2) : 0,
  estimatedIrrigationNetMm: liters > 0 ? +(liters * 0.85 / 1450).toFixed(2) : 0,
  totalWaterMm: +(rainMm + liters * 0.85 / 1450).toFixed(2),
  estimatedTotalWaterMm: +(rainMm + liters * 0.85 / 1450).toFixed(2),
});

const fullWater = {
  available: true, observedAt: nowIso(), areaM2: 1450, irrigationEfficiencyPct: 85,
  rainTodayMm: 0, irrigationTodayLiters: 440, irrigationTodayNetMm: 0.26,
  irrigationTodayMeasuredLiters: 440, irrigationTodayEstimatedLiters: 420,
  measuredIrrigationNetMm: 0.26, estimatedIrrigationNetMm: 0.25,
  waterNeededTodayMm: 4.1, balanceTodayMm: -1.2, next24hRainMm: 8.2,
  action: { code: 'SKIP_RAIN_EXPECTED', source: 'local', reasoning: '8.2 mm rain expected in the next 24 h — hold irrigation.', recommendationDate: nowIso().slice(0, 10) },
  daily: [waterDay(6, 0, 520), waterDay(5, 1.8, 260), waterDay(4, 0, 440), waterDay(3, 6.6, 0), waterDay(2, 0.8, 180), waterDay(1, 0, 440), waterDay(0, 0, 440)],
  sensorHealth: { sensorCount: 3, freshSensorCount: 3, staleSensorCount: 0, rainGaugePresent: true, flowMeterPresent: true, warnings: [] },
};

const emptyLocal = { available: false, observedAt: null, sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, devices: [], metrics: [] };

const liveOnline = {
  available: true, source: 'open_meteo', cacheStatus: 'live',
  observedAt: iso(-7 * 60_000), expiresAt: iso(23 * 60_000),
  current: {
    description: 'Partly cloudy', weatherCode: 2, airTemperatureC: 24.3,
    relativeHumidityPct: 52, pressureHpa: 1016, windSpeedMps: 2.8,
    windDirectionDeg: 240, cloudCoverPct: 40, rainMm: 0, precipitationProbabilityPct: 10,
  },
};

const liveForecast = {
  available: true, source: 'open_meteo', cacheStatus: 'live',
  observedAt: iso(-14 * 60_000), expiresAt: iso(46 * 60_000),
  rainFocus: {
    totalNext24hMm: 8.2, totalNext72hMm: 15.4, maxHourlyRainMm: 2.6,
    maxHourlyRainAt: iso(11 * 3600_000), nextRainEta: iso(8 * 3600_000), rainHoursNext24h: 6,
    daily: [
      { date: dayIso(0), description: 'Partly cloudy', weatherCode: 2, maxTempC: 25.1, minTempC: 14.6, rainMm: 2.4, rainProbabilityPct: 55, windSpeedMps: 2.8, et0MmDay: 4.4, etcMmDay: 3.7 },
      { date: dayIso(1), description: 'Moderate rain', weatherCode: 63, maxTempC: 19.8, minTempC: 13.2, rainMm: 9.6, rainProbabilityPct: 90, windSpeedMps: 4.5, et0MmDay: 2.6, etcMmDay: 2.2 },
      { date: dayIso(2), description: 'Light rain', weatherCode: 61, maxTempC: 21.5, minTempC: 12.9, rainMm: 3.4, rainProbabilityPct: 60, windSpeedMps: 3.1, et0MmDay: 3.2, etcMmDay: 2.7 },
      { date: dayIso(3), description: 'Mainly clear', weatherCode: 1, maxTempC: 25.9, minTempC: 13.8, rainMm: 0, rainProbabilityPct: 5, windSpeedMps: 2.2, et0MmDay: 4.8, etcMmDay: 4.0 },
      { date: dayIso(4), description: 'Clear sky', weatherCode: 0, maxTempC: 27.6, minTempC: 14.9, rainMm: 0, rainProbabilityPct: 0, windSpeedMps: 1.9, et0MmDay: 5.1, etcMmDay: 4.3 },
    ],
    hourly: Array.from({ length: 23 }, (_, i) => {
      const h = i + 1;
      const rain = h < 8 ? 0 : h < 14 ? +(0.6 * (h - 7)).toFixed(1) : 0.8;
      return { time: iso(h * 3600_000), rainMm: rain, rainProbabilityPct: h < 8 ? 10 + h * 5 : 80, tempC: 22 - h * 0.15, windSpeedMps: 3.0 };
    }),
  },
};

const missOnline = { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, current: null };
const missForecast = { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, rainFocus: null };
const agronomic = { preferredSource: 'open_meteo', current: null };

const summary = (zoneId: number, zoneName: string, over: Record<string, unknown>) => ({
  zoneId, zoneName, generatedAt: nowIso(),
  location: { latitude: 46.94, longitude: 7.44, timezone: 'Europe/Zurich', source: 'zone' },
  water: fullWater, local: emptyLocal, online: missOnline,
  agronomic, forecast: missForecast, display: null, drift: null,
  ...over,
});

((window as any).__dsApiRoutes ??= []).push(
  [/^\/api\/irrigation-zones\/21\/environment-summary$/, summary(21, 'Orchard — Block A', { online: liveOnline, forecast: liveForecast })],
  [/^\/api\/irrigation-zones\/22\/environment-summary$/, summary(22, 'Vineyard — Chasselas', {
    display: {
      mode: 'local_fallback', schedulingMode: 'server_preferred', sourceLabel: 'Local',
      sharedGeneratedAt: iso(-26 * 3600_000), sharedObservedAt: iso(-26 * 3600_000),
      lastReceivedAt: iso(-26 * 3600_000),
      fallbackReason: 'OSI Server data is older than 12 h — showing the locally computed recommendation instead.',
    },
  })],
);

const zone = (id: number, name: string) => ({
  id, name, device_count: 2,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: nowIso(),
  schedule: null, crop_type: 'apple', soil_type: 'loam', area_m2: 1450,
}) as any;

// The card mounts collapsed; click its chevron after mount, then optionally a
// tab by its label once the tab strip has rendered.
function AutoExpand({ tab, children }: { tab?: string; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const expand = () => {
      const spans = ref.current?.querySelectorAll('button span[style*="rotate(-90deg)"]') ?? [];
      spans.forEach((s) => (s as HTMLElement).closest('button')?.click());
    };
    expand();
    const t1 = setTimeout(expand, 60);
    const t2 = setTimeout(() => {
      if (!tab) return;
      const buttons = ref.current?.querySelectorAll('button') ?? [];
      buttons.forEach((b) => { if (b.textContent?.trim() === tab) (b as HTMLElement).click(); });
    }, 140);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [tab]);
  return <div ref={ref}>{children}</div>;
}

const W = { maxWidth: 760 };

// Canonical story: default canned summary (zone 12) on the default Water tab —
// full water balance with today's action and 7-day history.
export function WaterBalance() {
  return (
    <div style={W}>
      <AutoExpand>
        <EnvironmentCard zone={zone(12, 'Orchard — Zone B')} devices={[]} />
      </AutoExpand>
    </div>
  );
}

// Live open-meteo weather: Live cache badge in the header, Weather tab active
// with current conditions, rain pills, daily strip and hourly chart.
export function LiveWeather() {
  return (
    <div style={W}>
      <AutoExpand tab="Weather">
        <EnvironmentCard zone={zone(21, 'Orchard — Block A')} devices={[]} />
      </AutoExpand>
    </div>
  );
}

// Server-linked zone falling back to local data: sky "Local fallback" badge
// and the amber fallback-reason banner above the tabs.
export function ServerFallback() {
  return (
    <div style={W}>
      <AutoExpand>
        <EnvironmentCard zone={zone(22, 'Vineyard — Chasselas')} devices={[]} />
      </AutoExpand>
    </div>
  );
}
