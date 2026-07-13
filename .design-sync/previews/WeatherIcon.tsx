import React from 'react';
import { WeatherIcon } from 'open-smart-irrigation';

// The icon's clouds are light slate on transparent — always show them on a
// tinted sky panel. The labeled grid uses animated={false}: rain drops,
// snowflakes and the lightning bolt animate through opacity:0 and would be
// invisible in a badly-timed screenshot.
const Cell: React.FC<{ label: string; sub?: string; children: React.ReactNode }> = ({ label, sub, children }) => (
  <div
    style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
      background: 'linear-gradient(180deg, #dbeafe 0%, #eff6ff 100%)',
      border: '1px solid #bfdbfe', borderRadius: 12, padding: '12px 8px 8px', width: 108,
    }}
  >
    {children}
    <span style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>{label}</span>
    {sub && <span style={{ fontSize: 10, color: '#64748b' }}>{sub}</span>}
  </div>
);

const Grid: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, maxWidth: 640 }}>{children}</div>
);

// All nine icon types, static, each labeled with the condition it renders.
// (heavy-rain is only reachable via text description — no WMO code maps to it.)
export function AllConditions() {
  return (
    <Grid>
      <Cell label="Sunny"><WeatherIcon code={0} animated={false} /></Cell>
      <Cell label="Partly cloudy"><WeatherIcon code={2} animated={false} /></Cell>
      <Cell label="Cloudy"><WeatherIcon description="cloudy" animated={false} /></Cell>
      <Cell label="Overcast"><WeatherIcon code={3} animated={false} /></Cell>
      <Cell label="Foggy"><WeatherIcon code={45} animated={false} /></Cell>
      <Cell label="Rainy"><WeatherIcon code={61} animated={false} /></Cell>
      <Cell label="Heavy rain"><WeatherIcon description="heavy rain showers" animated={false} /></Cell>
      <Cell label="Thunderstorm"><WeatherIcon code={95} animated={false} /></Cell>
      <Cell label="Snowy"><WeatherIcon code={71} animated={false} /></Cell>
    </Grid>
  );
}

// The WMO weather-code mapping actually used by forecast data (open-meteo
// codes) — proves deterministic code → icon resolution.
export function WmoCodeMapping() {
  const codes: Array<[number, string]> = [
    [0, 'Clear'], [2, 'Partly cloudy'], [3, 'Overcast'], [45, 'Fog'],
    [55, 'Dense drizzle'], [63, 'Moderate rain'], [66, 'Freezing rain'],
    [75, 'Heavy snow'], [82, 'Violent showers'], [99, 'Hail thunderstorm'],
  ];
  return (
    <Grid>
      {codes.map(([code, label]) => (
        <Cell key={code} label={`WMO ${code}`} sub={label}>
          <WeatherIcon code={code} size={56} animated={false} />
        </Cell>
      ))}
    </Grid>
  );
}

// Size ramp (badge 24 px → hero 96 px) plus the animated default — the
// animated cells use conditions whose keyframes never fully disappear.
export function SizesAndAnimation() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        style={{
          display: 'flex', alignItems: 'flex-end', gap: 16,
          background: 'linear-gradient(180deg, #dbeafe, #eff6ff)',
          border: '1px solid #bfdbfe', borderRadius: 12, padding: 12, width: 'fit-content',
        }}
      >
        {[24, 40, 64, 96].map(s => (
          <div key={s} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <WeatherIcon code={2} size={s} animated={false} />
            <span style={{ fontSize: 10, color: '#64748b' }}>{s}px</span>
          </div>
        ))}
      </div>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 16,
          background: 'linear-gradient(180deg, #dbeafe, #eff6ff)',
          border: '1px solid #bfdbfe', borderRadius: 12, padding: 12, width: 'fit-content',
        }}
      >
        {(['sunny', 'partly cloudy', 'cloudy', 'fog'] as const).map(d => (
          <WeatherIcon key={d} description={d} size={56} />
        ))}
        <span style={{ fontSize: 11, color: '#64748b' }}>animated (default)</span>
      </div>
    </div>
  );
}
