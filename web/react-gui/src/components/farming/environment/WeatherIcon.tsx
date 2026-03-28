import React from 'react';
import './weatherIconStyles.css';

export type WeatherIconType =
  | 'sunny'
  | 'partly-cloudy'
  | 'cloudy'
  | 'overcast'
  | 'rainy'
  | 'heavy-rain'
  | 'thunderstorm'
  | 'snowy'
  | 'foggy';

interface WeatherIconProps {
  /** WMO weather code (preferred for deterministic mapping) */
  code?: number | null;
  /** Text description fallback when no WMO code */
  description?: string | null;
  /** SVG size in px, default 64 */
  size?: number;
  /** Set false to disable CSS animations (e.g. small badges) */
  animated?: boolean;
}

// ── WMO code → icon type ──────────────────────────────────────────────────────

function iconTypeFromCode(code: number): WeatherIconType {
  if (code === 0 || code === 1) return 'sunny';
  if (code === 2)               return 'partly-cloudy';
  if (code === 3)               return 'overcast';
  if (code === 45 || code === 48) return 'foggy';
  if (code >= 51 && code <= 57) return 'rainy';
  if (code >= 61 && code <= 65) return 'rainy';
  if (code === 66 || code === 67) return 'snowy';
  if (code >= 71 && code <= 77) return 'snowy';
  if (code >= 80 && code <= 82) return 'rainy';
  if (code === 83 || code === 84) return 'snowy';
  if (code === 85 || code === 86) return 'snowy';
  if (code >= 95 && code <= 99) return 'thunderstorm';
  return 'cloudy';
}

// ── Text description → icon type ─────────────────────────────────────────────

function iconTypeFromDescription(desc: string): WeatherIconType {
  const d = desc.toLowerCase();
  if (d.includes('thunder') || d.includes('storm'))      return 'thunderstorm';
  if (d.includes('heavy rain') || d.includes('shower'))  return 'heavy-rain';
  if (d.includes('drizzle') || d.includes('rain'))       return 'rainy';
  if (d.includes('snow') || d.includes('sleet'))         return 'snowy';
  if (d.includes('fog') || d.includes('mist') || d.includes('haze')) return 'foggy';
  if (d.includes('overcast'))                            return 'overcast';
  if (d.includes('partly') || d.includes('partial'))    return 'partly-cloudy';
  if (d.includes('cloud'))                               return 'cloudy';
  if (d.includes('clear') || d.includes('sunny') || d.includes('fair')) return 'sunny';
  return 'cloudy';
}

export function resolveIconType(code?: number | null, description?: string | null): WeatherIconType {
  if (code != null) return iconTypeFromCode(code);
  if (description)  return iconTypeFromDescription(description);
  return 'cloudy';
}

// ── SVG icon renderers ────────────────────────────────────────────────────────

// Reusable cloud path — centred around (cx, cy) with radius scale r
function CloudShape({ cx, cy, r, fill, className }: {
  cx: number; cy: number; r: number; fill: string; className?: string;
}) {
  // A simple cloud made of three overlapping circles + a rectangle base
  const s = r;
  return (
    <g className={className}>
      <ellipse cx={cx}       cy={cy}      rx={s * 1.1} ry={s * 0.7} fill={fill} />
      <ellipse cx={cx - s * 0.7} cy={cy + s * 0.25} rx={s * 0.75} ry={s * 0.55} fill={fill} />
      <ellipse cx={cx + s * 0.7} cy={cy + s * 0.25} rx={s * 0.65} ry={s * 0.5}  fill={fill} />
      <rect x={cx - s * 1.45} y={cy + s * 0.2} width={s * 2.9} height={s * 0.8} rx={s * 0.3} fill={fill} />
    </g>
  );
}

// Sun (circle + rays)
function SunShape({ cx, cy, r, animated }: { cx: number; cy: number; r: number; animated: boolean }) {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const angle = (i * Math.PI * 2) / 8;
    const inner = r * 1.35;
    const outer = r * 1.75;
    return (
      <line
        key={i}
        x1={cx + Math.cos(angle) * inner}
        y1={cy + Math.sin(angle) * inner}
        x2={cx + Math.cos(angle) * outer}
        y2={cy + Math.sin(angle) * outer}
        stroke="#FBBF24"
        strokeWidth={r * 0.18}
        strokeLinecap="round"
      />
    );
  });
  return (
    <g>
      <g className={animated ? 'wi-sun-rays' : ''} style={{ transformOrigin: `${cx}px ${cy}px` }}>
        {rays}
      </g>
      <circle cx={cx} cy={cy} r={r} fill="#FCD34D" className={animated ? 'wi-sun-core' : ''} />
    </g>
  );
}

// ── Individual icon components ────────────────────────────────────────────────

function SunnyIcon({ size, animated }: { size: number; animated: boolean }) {
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      <SunShape cx={c} cy={c} r={size * 0.22} animated={animated} />
    </svg>
  );
}

function PartlyCloudyIcon({ size, animated }: { size: number; animated: boolean }) {
  const c = size / 2;
  const sunCx = c - size * 0.08;
  const sunCy = c - size * 0.08;
  const sunR  = size * 0.18;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      <g className={animated ? 'wi-sun-peek' : ''} style={{ transformOrigin: `${sunCx}px ${sunCy}px` }}>
        <SunShape cx={sunCx} cy={sunCy} r={sunR} animated={false} />
      </g>
      <CloudShape
        cx={c + size * 0.06}
        cy={c + size * 0.1}
        r={size * 0.22}
        fill="#E2E8F0"
        className={animated ? 'wi-cloud-main' : ''}
      />
    </svg>
  );
}

function CloudyIcon({ size, animated }: { size: number; animated: boolean }) {
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      <CloudShape
        cx={c + size * 0.06}
        cy={c - size * 0.04}
        r={size * 0.18}
        fill="#CBD5E1"
        className={animated ? 'wi-cloud-float' : ''}
      />
      <CloudShape
        cx={c - size * 0.06}
        cy={c + size * 0.1}
        r={size * 0.22}
        fill="#E2E8F0"
        className={animated ? 'wi-cloud-main' : ''}
      />
    </svg>
  );
}

function OvercastIcon({ size, animated }: { size: number; animated: boolean }) {
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      <CloudShape
        cx={c}
        cy={c - size * 0.04}
        r={size * 0.19}
        fill="#94A3B8"
        className={animated ? 'wi-cloud-float' : ''}
      />
      <CloudShape
        cx={c}
        cy={c + size * 0.1}
        r={size * 0.24}
        fill="#CBD5E1"
        className={animated ? 'wi-cloud-main' : ''}
      />
    </svg>
  );
}

function RainyIcon({ size, animated, heavy }: { size: number; animated: boolean; heavy: boolean }) {
  const c  = size / 2;
  const cy = c - size * 0.05;
  const dropCount = heavy ? 6 : 4;
  const speed     = heavy ? 'wi-heavy-drop' : 'wi-raindrop';
  // drop positions spread evenly under cloud
  const dropXs = heavy
    ? [c - size*0.2, c - size*0.08, c + size*0.04, c + size*0.16, c - size*0.14, c + size*0.1]
    : [c - size*0.15, c, c + size*0.15, c - size*0.07];
  const dropY1 = cy + size * 0.25;
  const dropLen = size * 0.1;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      <CloudShape
        cx={c}
        cy={cy}
        r={size * 0.22}
        fill={heavy ? '#64748B' : '#94A3B8'}
        className={animated ? 'wi-cloud-main' : ''}
      />
      {Array.from({ length: dropCount }, (_, i) => (
        <line
          key={i}
          x1={dropXs[i]}
          y1={dropY1}
          x2={dropXs[i] - size * 0.03}
          y2={dropY1 + dropLen}
          stroke="#60A5FA"
          strokeWidth={heavy ? size * 0.045 : size * 0.04}
          strokeLinecap="round"
          className={animated ? `${speed}-${i + 1}` : ''}
        />
      ))}
    </svg>
  );
}

function ThunderstormIcon({ size, animated }: { size: number; animated: boolean }) {
  const c  = size / 2;
  const cy = c - size * 0.06;
  // Lightning bolt path
  const bx = c + size * 0.04;
  const by = cy + size * 0.22;
  const bolt = `M ${bx} ${by} L ${bx - size*0.1} ${by + size*0.14} L ${bx - size*0.02} ${by + size*0.14} L ${bx - size*0.13} ${by + size*0.28} L ${bx + size*0.06} ${by + size*0.1} L ${bx - size*0.01} ${by + size*0.1} Z`;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      <g className={animated ? 'wi-storm-cloud' : ''} style={{ transformOrigin: `${c}px ${cy}px` }}>
        <CloudShape cx={c} cy={cy} r={size * 0.22} fill="#475569" />
      </g>
      <path
        d={bolt}
        fill="#FDE047"
        stroke="#EAB308"
        strokeWidth={size * 0.015}
        strokeLinejoin="round"
        className={animated ? 'wi-lightning' : ''}
      />
      {/* a couple of rain drops beside bolt */}
      <line
        x1={c - size*0.18} y1={cy + size*0.25}
        x2={c - size*0.21} y2={cy + size*0.35}
        stroke="#60A5FA" strokeWidth={size*0.04} strokeLinecap="round"
        className={animated ? 'wi-raindrop-1' : ''}
      />
      <line
        x1={c - size*0.06} y1={cy + size*0.27}
        x2={c - size*0.09} y2={cy + size*0.37}
        stroke="#60A5FA" strokeWidth={size*0.04} strokeLinecap="round"
        className={animated ? 'wi-raindrop-3' : ''}
      />
    </svg>
  );
}

function SnowyIcon({ size, animated }: { size: number; animated: boolean }) {
  const c  = size / 2;
  const cy = c - size * 0.05;
  const flakeXs = [c - size*0.14, c + size*0.02, c + size*0.15, c - size*0.06, c + size*0.1, c - size*0.18];
  const flakeY  = cy + size * 0.27;
  const flakeR  = size * 0.04;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      <CloudShape
        cx={c}
        cy={cy}
        r={size * 0.22}
        fill="#94A3B8"
        className={animated ? 'wi-cloud-main' : ''}
      />
      {flakeXs.map((fx, i) => (
        <circle
          key={i}
          cx={fx}
          cy={flakeY + (i % 2) * size * 0.06}
          r={flakeR}
          fill="#BAE6FD"
          className={animated ? `wi-snow-${i + 1}` : ''}
        />
      ))}
    </svg>
  );
}

function FoggyIcon({ size, animated }: { size: number; animated: boolean }) {
  const c = size / 2;
  const lines = [
    { y: c - size * 0.12, w: size * 0.55, cls: 'wi-fog-1' },
    { y: c,               w: size * 0.65, cls: 'wi-fog-2' },
    { y: c + size * 0.12, w: size * 0.5,  cls: 'wi-fog-3' },
  ];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      {lines.map((l, i) => (
        <line
          key={i}
          x1={c - l.w / 2}
          y1={l.y}
          x2={c + l.w / 2}
          y2={l.y}
          stroke="#94A3B8"
          strokeWidth={size * 0.07}
          strokeLinecap="round"
          className={animated ? l.cls : ''}
        />
      ))}
    </svg>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

export const WeatherIcon: React.FC<WeatherIconProps> = ({
  code,
  description,
  size = 64,
  animated = true,
}) => {
  const type = resolveIconType(code, description);

  switch (type) {
    case 'sunny':        return <SunnyIcon        size={size} animated={animated} />;
    case 'partly-cloudy': return <PartlyCloudyIcon size={size} animated={animated} />;
    case 'cloudy':       return <CloudyIcon        size={size} animated={animated} />;
    case 'overcast':     return <OvercastIcon      size={size} animated={animated} />;
    case 'rainy':        return <RainyIcon         size={size} animated={animated} heavy={false} />;
    case 'heavy-rain':   return <RainyIcon         size={size} animated={animated} heavy={true} />;
    case 'thunderstorm': return <ThunderstormIcon  size={size} animated={animated} />;
    case 'snowy':        return <SnowyIcon         size={size} animated={animated} />;
    case 'foggy':        return <FoggyIcon         size={size} animated={animated} />;
    default:             return <CloudyIcon        size={size} animated={animated} />;
  }
};
