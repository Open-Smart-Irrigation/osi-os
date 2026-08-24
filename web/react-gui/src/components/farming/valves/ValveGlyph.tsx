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

// Geometry from the OSI OS valve-state icon package v2 (`OSI_OS_valve_icons_v2`), whose body
// paths derive from Google's Material Symbols Rounded `valve` glyph (Apache-2.0 — see
// docs/THIRD_PARTY_NOTICES.md). The package's viewBox is Material's `0 -960 960 1000`, kept
// verbatim so the donated paths are not re-scaled by hand: transcription errors in a 700-char
// path are invisible in review and show up as a subtly broken icon.
const VIEW_BOX = '0 -960 960 1000';
const OUTLINE_PATH = 'M440-760H320q-17 0-28.5-11.5T280-800q0-17 11.5-28.5T320-840h320q17 0 28.5 11.5T680-800q0 17-11.5 28.5T640-760H520v80q0 17-11.5 28.5T480-640q-17 0-28.5-11.5T440-680v-80ZM160-159v-242q0-17 11.5-28.5T200-441q17 0 28.5 11.5T240-401v1h120v-120h-1q-17 0-28.5-11.5T319-560q0-17 11.5-28.5T359-600h242q17 0 28.5 11.5T641-560q0 17-11.5 28.5T601-520h-1v120h120v-1q0-17 11.5-28.5T760-441q17 0 28.5 11.5T800-401v242q0 17-11.5 28.5T760-119q-17 0-28.5-11.5T720-159v-1H240v1q0 17-11.5 28.5T200-119q-17 0-28.5-11.5T160-159Zm80-81h480v-80H520v-200h-80v200H240v80Zm240 0Z';
const FILLED_PATH = 'M440-760H320q-17 0-28.5-11.5T280-800q0-17 11.5-28.5T320-840h320q17 0 28.5 11.5T680-800q0 17-11.5 28.5T640-760H520v80q0 17-11.5 28.5T480-640q-17 0-28.5-11.5T440-680v-80ZM160-159v-242q0-17 11.5-28.5T200-441q17 0 28.5 11.5T240-401v1h120v-120h-1q-17 0-28.5-11.5T319-560q0-17 11.5-28.5T359-600h242q17 0 28.5 11.5T641-560q0 17-11.5 28.5T601-520h-1v120h120v-1q0-17 11.5-28.5T760-441q17 0 28.5 11.5T800-401v242q0 17-11.5 28.5T760-119q-17 0-28.5-11.5T720-159v-1H240v1q0 17-11.5 28.5T200-119q-17 0-28.5-11.5T160-159Z';
const WATER_PATH = 'M790 -286 C842 -286 858 -252 851 -216 C844 -179 883 -151 880 -62';

// Countdown ring, sized in the same 960 space: r=470 about (480,-470) clears the body
// (x 160..800, y -840..-119) without leaving the viewBox.
const RING_RADIUS = 470;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const BADGE_TRANSFORM = 'translate(770, -800)';
const BADGE_RADIUS = 140;

export const ValveGlyph: React.FC<ValveGlyphProps> = ({ state, progress, size = 48, reducedMotion = false }) => {
  const isOpen = state === 'open';
  const isPending = state === 'pending';
  const isClosing = state === 'closing';
  const isFailed = state === 'failed';

  // The valve body is filled only when water is actually moving through it. `pending` is a
  // command the valve has not confirmed and `failed` is a plan it never took, so both keep the
  // hollow outline — the package README makes the same point: an unacknowledged command must
  // not look like a running valve.
  const bodyFilled = isOpen || isClosing;

  // Water is drawn for `closing` too, but frozen: the valve is still reporting open, so showing
  // a dry outlet would be a lie, while animating it would suggest a run that is already over.
  const showWater = isOpen || isClosing;
  const animateWater = isOpen && !reducedMotion;

  const showRing = progress !== null;
  const clampedProgress = showRing ? Math.max(0, Math.min(1, progress as number)) : 0;
  const ringOffset = RING_CIRCUMFERENCE * (1 - clampedProgress);

  const stateClass = `valve-glyph--${state}`;
  const motionClass = animateWater ? '' : 'valve-glyph--static';

  return (
    <span
      className={`valve-glyph ${stateClass} ${motionClass} relative inline-flex shrink-0 items-center justify-center`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox={VIEW_BOX} width={size} height={size} className="valve-glyph__svg overflow-visible">
        {showRing && (
          <circle
            className="valve-glyph__ring"
            cx="480"
            cy="-470"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="38"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={ringOffset}
            transform="rotate(-90 480 -470)"
          />
        )}

        {/* Water sits behind the body so it reads as emerging from the outlet. */}
        {showWater && (
          <g className="valve-glyph__water">
            <path className="valve-glyph__water-edge" d={WATER_PATH} />
            <path className="valve-glyph__water-main" d={WATER_PATH} />
            <path className="valve-glyph__water-band valve-glyph__water-band--a" d={WATER_PATH} />
            <path className="valve-glyph__water-band valve-glyph__water-band--b" d={WATER_PATH} />
            {/* Static offsets live in cx/cy, never in a transform attribute: the drop keyframes
                set `transform` in CSS, and a CSS transform replaces an SVG transform attribute
                outright rather than composing with it. */}
            <g className="valve-glyph__drop valve-glyph__drop--a">
              <circle cx="835" cy="-15" r="18" />
              <circle className="valve-glyph__drop-shine" cx="831" cy="-20" r="7" />
            </g>
            <g className="valve-glyph__drop valve-glyph__drop--b">
              <circle cx="926" cy="-28" r="16" />
              <circle className="valve-glyph__drop-shine" cx="922" cy="-33" r="6" />
            </g>
            <g className="valve-glyph__drop valve-glyph__drop--c">
              <circle cx="895" cy="12" r="11" />
            </g>
          </g>
        )}

        <path className="valve-glyph__body" d={bodyFilled ? FILLED_PATH : OUTLINE_PATH} />

        {isPending && (
          <g className="valve-glyph__badge valve-glyph__badge--pending" transform={BADGE_TRANSFORM}>
            <circle r={BADGE_RADIUS} />
            <path d="M0 -64v64l48 30" fill="none" strokeWidth="30" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        )}
        {isClosing && (
          <g className="valve-glyph__badge valve-glyph__badge--closing" transform={BADGE_TRANSFORM}>
            <circle r={BADGE_RADIUS} />
            <path
              d="M-52 -62h104M-52 62h104M-44 -62c0 48 88 48 88 0M-44 62c0-48 88-48 88 0"
              fill="none"
              strokeWidth="24"
            />
          </g>
        )}
        {isFailed && (
          <g className="valve-glyph__badge valve-glyph__badge--failed" transform={BADGE_TRANSFORM}>
            <circle r={BADGE_RADIUS} />
            <path d="M0 -62v52" strokeWidth="32" strokeLinecap="round" fill="none" />
            <circle className="valve-glyph__badge-dot" cx="0" cy="48" r="18" />
          </g>
        )}
      </svg>
    </span>
  );
};

export default ValveGlyph;
