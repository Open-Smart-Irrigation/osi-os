import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { SwtWaterStatus } from '../../../utils/swt';

interface SwtStatusIndicatorProps {
  status: SwtWaterStatus | null;
  className?: string;
}

const VISUALS: Record<SwtWaterStatus, { color: string; background: string }> = {
  wet: { color: 'var(--soil-wet)', background: 'var(--soil-wet-bg)' },
  moist: { color: 'var(--soil-moist)', background: 'var(--soil-moist-bg)' },
  dry: { color: 'var(--soil-dry)', background: 'var(--soil-dry-bg)' },
};

export function SwtStatusIndicator({ status, className = '' }: SwtStatusIndicatorProps) {
  const { t } = useTranslation('history');
  if (status === null) return null;
  const visual = VISUALS[status];
  const style: CSSProperties = { backgroundColor: visual.background, borderColor: visual.color };
  return (
    <span data-swt-status={status} style={style}
      className={`inline-flex min-h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-xs font-semibold text-[var(--text)] ${className}`.trim()}>
      <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: visual.color }} />
      {t(`history.soil.state.${status}`)}
    </span>
  );
}
