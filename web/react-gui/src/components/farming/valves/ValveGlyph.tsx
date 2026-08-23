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
// (#160) The open state must follow the APP theme, not the OS one. The previous
// `text-blue-600 dark:text-blue-400` pair keyed off Tailwind's `dark:` variant, which tracks
// the OS/`dark` class rather than `html[data-theme]`, so the glyph rendered the wrong colour
// whenever the two disagreed. `--primary` is defined for both themes in index.css.
const OPEN_ACCENT = 'var(--primary)';

const RING_RADIUS = 27;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// A single teardrop, apex up, bulb centred at (32,34) with r=14 so it sits inside the
// progress ring (r=27 about (32,32)). State is carried by FILL rather than by geometry:
// at tile size the old gate-valve schematic's 1.4px wheel/stem detail was the first thing
// to disappear (#160), so the shape stays constant and only the fill/stroke change.
const DROPLET_PATH = 'M32 6C39 19 46 26 46 34a14 14 0 1 1-28 0c0-8 7-15 14-28Z';
// The falling drip, drawn small and reused three times below the bulb.
const DRIP_PATH = 'M0 0c-2.1 2.5-3.3 4.4-3.3 6a3.3 3.3 0 1 0 6.6 0C3.3 4.4 2.1 2.5 0 0Z';

export const ValveGlyph: React.FC<ValveGlyphProps> = ({ state, progress, size = 48, reducedMotion = false }) => {
  const isOpen = state === 'open';
  const isPending = state === 'pending';
  const isClosing = state === 'closing';
  const isFailed = state === 'failed';

  const stroke = isOpen ? OPEN_ACCENT : MUTED_STROKE;
  const dashArray = isPending ? '5 4' : undefined;

  const showRing = progress !== null;
  const clampedProgress = showRing ? Math.max(0, Math.min(1, progress as number)) : 0;
  const ringOffset = RING_CIRCUMFERENCE * (1 - clampedProgress);

  const animateDroplets = isOpen && !reducedMotion;

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, color: isOpen ? OPEN_ACCENT : MUTED_STROKE }}
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
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={ringOffset}
            transform="rotate(-90 32 32)"
            opacity={0.55}
          />
        )}

        {/* The droplet itself: solid when water is flowing, hollow when it is not. */}
        <path
          d={DROPLET_PATH}
          fill={isOpen ? 'currentColor' : 'none'}
          stroke={stroke}
          strokeWidth="3"
          strokeLinejoin="round"
          strokeDasharray={dashArray}
        />

        {/* Droplets falling from the bulb. The per-droplet x/y offset lives on this wrapping
            <g> — the CSS keyframes below set the inner <path>'s `transform` (translateY) while
            animating, and a CSS transform completely replaces an SVG transform *attribute*
            rather than composing with it, so the offset must not sit on the animated node
            itself or all droplets collapse to the same x position while dripping. */}
        {isOpen && [0, 1, 2].map((i) => (
          <g key={i} transform={`translate(${32 + (i - 1) * 9}, ${52 + (i === 1 ? 3 : 0)})`}>
            <path
              d={DRIP_PATH}
              fill="currentColor"
              opacity={animateDroplets ? undefined : 0.85}
              className={animateDroplets ? 'valve-drip' : undefined}
              style={animateDroplets ? { animationDelay: `${i * 0.35}s` } : undefined}
            />
          </g>
        ))}

        {/* Status badge */}
        {isPending && (
          <g transform="translate(48, 12)">
            <circle r="9" fill="var(--surface)" stroke={PENDING_STROKE} strokeWidth="1.8" />
            <path d="M0 -4.2v4.2l3.1 1.9" fill="none" stroke={PENDING_STROKE} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        )}
        {isClosing && (
          <g transform="translate(48, 12)">
            <circle r="9" fill="var(--surface)" stroke={MUTED_STROKE} strokeWidth="1.8" />
            <path
              d="M-3.4 -4.1h6.8M-3.4 4.1h6.8M-2.9 -4.1c0 3.1 5.3 3.1 5.3 0M-2.9 4.1c0-3.1 5.3-3.1 5.3 0"
              fill="none"
              stroke={MUTED_STROKE}
              strokeWidth="1.4"
            />
          </g>
        )}
        {isFailed && (
          <g transform="translate(48, 12)">
            <circle r="9" fill="var(--surface)" stroke={FAILED_ACCENT} strokeWidth="1.8" />
            <path d="M0 -3.9v3.4" stroke={FAILED_ACCENT} strokeWidth="1.9" strokeLinecap="round" />
            <circle cx="0" cy="3.2" r="1.1" fill={FAILED_ACCENT} />
          </g>
        )}
      </svg>
    </span>
  );
};

export default ValveGlyph;
