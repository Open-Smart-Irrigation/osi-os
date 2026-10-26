import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { SwtWaterStatus } from '../../../utils/swt';

interface SwtStatusIndicatorProps {
  status: SwtWaterStatus | null;
  className?: string;
}

// The dot's fill level is the non-colour cue: full for wet, half for moist, an empty ring for
// dry. Moist green and dry red collapse to near-identical olives for a red-green dichromat
// (CIEDE2000 5.4 light / 6.9 dark; see docs/superpowers/previews/swt-water-status/implemented/
// contrast-cvd.mjs), so the shape, not the hue, separates them.
const VISUALS: Record<SwtWaterStatus, { color: string; background: string; fill: 'full' | 'half' | 'empty' }> = {
  wet: { color: 'var(--soil-wet)', background: 'var(--soil-wet-bg)', fill: 'full' },
  moist: { color: 'var(--soil-moist)', background: 'var(--soil-moist-bg)', fill: 'half' },
  dry: { color: 'var(--soil-dry)', background: 'var(--soil-dry-bg)', fill: 'empty' },
};

export function SwtStatusIndicator({ status, className = '' }: SwtStatusIndicatorProps) {
  const { t } = useTranslation('history');
  if (status === null) return null;
  const visual = VISUALS[status];
  const style: CSSProperties = { backgroundColor: visual.background, borderColor: visual.color };
  return (
    <span data-swt-status={status} style={style}
      className={`inline-flex min-h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-xs font-semibold text-[var(--text)] ${className}`.trim()}>
      <span aria-hidden="true" data-swt-fill={visual.fill}
        className="relative h-3 w-3 shrink-0 overflow-hidden rounded-full border-2"
        style={{ borderColor: visual.color, backgroundColor: visual.fill === 'full' ? visual.color : 'transparent' }}>
        {visual.fill === 'half' && (
          <span className="absolute inset-x-0 bottom-0 h-1/2" style={{ backgroundColor: visual.color }} />
        )}
      </span>
      {t(`history.soil.state.${status}`)}
    </span>
  );
}
