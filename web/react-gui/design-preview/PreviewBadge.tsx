import { useTranslation } from 'react-i18next';
import type { Device } from '../src/types/farming';
import { formatSwtValue, type SwtUnit } from '../src/utils/swt';

// Prototype only. Task 1/3 replace these rules with the tested production helpers.
export function previewFresh(observed: string | null | undefined): boolean {
  if (!observed) return false;
  const age = Date.now() - Date.parse(observed);
  return Number.isFinite(age) && age >= -5 * 60_000 && age <= 3 * 60 * 60_000;
}

export function previewFormat(value: unknown, unit: SwtUnit): string | null {
  return value === 0 ? formatSwtValue(0, 'kPa') : formatSwtValue(value, unit);
}

export function PreviewBadge({ value, device, observedAt }: {
  value: unknown; device?: Device; observedAt?: string | null;
}) {
  const { t } = useTranslation('history');
  if (!previewFresh(device?.last_seen ?? observedAt)
    || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 300) return null;
  if (device?.latest_data.chameleon_i2c_missing === 1
    || device?.latest_data.chameleon_timeout === 1) return null;
  const status = value < 20 ? 'wet' : value <= 50 ? 'moist' : 'dry';
  return (
    <span data-swt-status={status} className="preview-badge" style={{
      borderColor: `var(--soil-${status})`, backgroundColor: `var(--soil-${status}-bg)`,
    }}>
      <span aria-hidden="true" className="preview-dot" style={{ backgroundColor: `var(--soil-${status})` }} />
      {t(`history.soil.state.${status}`)}
    </span>
  );
}
