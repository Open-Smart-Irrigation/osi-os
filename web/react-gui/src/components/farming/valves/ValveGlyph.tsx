import React from 'react';
import './valveGlyphStyles.css';
import type { ValveGlyphState } from './valveState';

export interface ValveGlyphProps {
  state: ValveGlyphState;
  progress: number | null;
  size?: number;
  reducedMotion?: boolean;
}

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** `t` should already be scoped to the `valves` namespace (e.g. `useTranslation('valves').t`). */
export function valveGlyphLabel(state: ValveGlyphState, t: Translate): string {
  return t(`state.${state}`);
}

// Design tokens: `--text-muted` does not exist in the token set (see index.css); the closest
// existing token for de-emphasized strokes is `--text-tertiary`, used the same way elsewhere
// (StregaValveCard, IrrigationOutcomesPanel).
const MUTED_STROKE = 'var(--text-tertiary)';
const PENDING_STROKE = '#b45309';
const FAILED_ACCENT = '#dc2626';

const RING_RADIUS = 27;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export const ValveGlyph: React.FC<ValveGlyphProps> = ({ state, progress, size = 48, reducedMotion = false }) => {
  const isOpen = state === 'open';
  const isPending = state === 'pending';
  const isClosing = state === 'closing';
  const isFailed = state === 'failed';

  const stroke = isOpen ? 'currentColor' : MUTED_STROKE;
  const dashArray = isPending ? '4 3' : undefined;
  // Gate lifts out of the pipe when open or closing (fluid path clear); stays seated when
  // closed, pending (still commanded but not yet confirmed open), or failed.
  const gateY = isOpen || isClosing ? 10 : 22;

  const showRing = progress !== null;
  const clampedProgress = showRing ? Math.max(0, Math.min(1, progress as number)) : 0;
  const ringOffset = RING_CIRCUMFERENCE * (1 - clampedProgress);

  const wrapperClass = isOpen ? 'text-blue-600 dark:text-blue-400' : '';
  const animateDroplets = isOpen && !reducedMotion;

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center ${wrapperClass}`}
      style={{ width: size, height: size, color: isOpen ? undefined : MUTED_STROKE }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 64 64" width={size} height={size} className="overflow-visible">
        {showRing && (
          <circle
            cx="32"
            cy="32"
            r={RING_RADIUS}
            fill="none"
            stroke={isFailed ? FAILED_ACCENT : 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={ringOffset}
            transform="rotate(-90 32 32)"
            opacity={0.55}
          />
        )}

        {/* Actuator wheel + stem */}
        <circle cx="32" cy="8" r="4.5" fill="none" stroke={stroke} strokeWidth="2.2" strokeDasharray={dashArray} />
        <line x1="28" y1="8" x2="36" y2="8" stroke={stroke} strokeWidth="1.4" />
        <line x1="32" y1="4.5" x2="32" y2="11.5" stroke={stroke} strokeWidth="1.4" />
        <line x1="32" y1="12.5" x2="32" y2={gateY} stroke={stroke} strokeWidth="2.2" strokeDasharray={dashArray} />

        {/* Horizontal pipe */}
        <rect
          x="8"
          y="26"
          width="48"
          height="8"
          rx="2"
          fill={isOpen ? 'currentColor' : 'none'}
          fillOpacity={isOpen ? 0.16 : undefined}
          stroke={stroke}
          strokeWidth="2.2"
          strokeDasharray={dashArray}
        />

        {/* Gate */}
        <rect
          x="26"
          y={gateY}
          width="6"
          height="14"
          rx="1"
          fill={isOpen ? 'currentColor' : stroke}
          stroke={stroke}
          strokeWidth="1.2"
          strokeDasharray={dashArray}
        />

        {/* Droplets at the outlet */}
        {isOpen && [0, 1, 2].map((i) => (
          <path
            key={i}
            d="M47 39c-2.1 2.5-3.3 4.4-3.3 6a3.3 3.3 0 1 0 6.6 0c0-1.6-1.2-3.5-3.3-6Z"
            fill="currentColor"
            opacity={animateDroplets ? undefined : 0.85}
            className={animateDroplets ? 'valve-drip' : undefined}
            style={animateDroplets ? { animationDelay: `${i * 0.35}s` } : undefined}
            transform={`translate(${(i - 1) * 7}, ${i * 3})`}
          />
        ))}

        {/* Status badge */}
        {isPending && (
          <g transform="translate(46, 8)">
            <circle r="7.5" fill="var(--surface)" stroke={PENDING_STROKE} strokeWidth="1.4" />
            <path d="M0 -3.5v3.5l2.6 1.6" fill="none" stroke={PENDING_STROKE} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        )}
        {isClosing && (
          <g transform="translate(46, 8)">
            <circle r="7.5" fill="var(--surface)" stroke={MUTED_STROKE} strokeWidth="1.4" />
            <path
              d="M-2.8 -3.4h5.6M-2.8 3.4h5.6M-2.4 -3.4c0 2.6 4.4 2.6 4.4 0M-2.4 3.4c0-2.6 4.4-2.6 4.4 0"
              fill="none"
              stroke={MUTED_STROKE}
              strokeWidth="1.1"
            />
          </g>
        )}
        {isFailed && (
          <g transform="translate(46, 8)">
            <circle r="7.5" fill="var(--surface)" stroke={FAILED_ACCENT} strokeWidth="1.4" />
            <path d="M0 -3.2v2.8" stroke={FAILED_ACCENT} strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="0" cy="2.6" r="0.9" fill={FAILED_ACCENT} />
          </g>
        )}
      </svg>
    </span>
  );
};

export default ValveGlyph;
