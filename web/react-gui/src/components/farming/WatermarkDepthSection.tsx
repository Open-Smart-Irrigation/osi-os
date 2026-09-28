import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deviceMetadataAPI } from '../../services/api';
import type { Device } from '../../types/farming';

const DEPTH_MIN_CM = 1;
const DEPTH_MAX_CM = 1000;

/**
 * `null` means "blank, clear the saved depth". `'invalid'` means the field is
 * neither blank nor a whole centimetre in range, matching what the edge's
 * `put-soil-depth-fn` accepts. `Number(raw)` alone is not enough here: it
 * turns "20 cm" or the de-CH decimal comma "20,5" into `NaN`, which
 * `JSON.stringify` serialises as `null`, and the edge treats a `null` depth
 * as "clear this key" -- silently erasing a previously saved depth behind a
 * "Depths saved." message instead of rejecting the input.
 */
function parseDepth(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const n = Number(trimmed);
  return n >= DEPTH_MIN_CM && n <= DEPTH_MAX_CM ? n : 'invalid';
}

// Probe depths use the existing generic soil_moisture_probe_depths_json
// mechanism (spec section 6), keyed swt_1 / swt_2 like KIWI's.
export function WatermarkDepthSection({ device, onUpdate }: { device: Device; onUpdate?: () => void }) {
  const { t } = useTranslation('devices');
  const current = device.soil_moisture_probe_depths_json ?? {};
  const [depths, setDepths] = useState<Record<'swt_1' | 'swt_2', string>>({
    swt_1: current.swt_1 != null ? String(current.swt_1) : '',
    swt_2: current.swt_2 != null ? String(current.swt_2) : '',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onSave = async () => {
    const next: Record<string, number> = { ...current };
    for (const key of ['swt_1', 'swt_2'] as const) {
      const parsed = parseDepth(depths[key]);
      if (parsed === 'invalid') {
        setMessage(t('watermark.depths.invalid'));
        return;
      }
      if (parsed === null) delete next[key];
      else next[key] = parsed;
    }
    setBusy(true); setMessage(null);
    try {
      await deviceMetadataAPI.setSoilMoistureDepths(device.deveui, next);
      setMessage(t('watermark.depths.saved'));
      onUpdate?.();
    } catch (error) {
      setMessage(String((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? error));
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {(['swt_1', 'swt_2'] as const).map((key, i) => (
          <label key={key} className="text-xs text-[var(--text-secondary)]">
            {t('watermark.depths.depth', { n: i + 1 })}
            <input
              name={`depth_${key}`}
              inputMode="numeric"
              value={depths[key]}
              onChange={(e) => setDepths((d) => ({ ...d, [key]: e.target.value }))}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)]"
            />
          </label>
        ))}
      </div>
      <button type="button" disabled={busy} onClick={onSave} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm">{t('watermark.depths.save')}</button>
      {message && <p className="text-xs text-[var(--text-secondary)]">{message}</p>}
    </div>
  );
}
