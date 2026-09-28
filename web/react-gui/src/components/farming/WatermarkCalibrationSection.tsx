import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { isAxiosError } from 'axios';
import { lsn50API } from '../../services/api';
import type { Device, WatermarkCalibrationValues, WatermarkPreviewChannel } from '../../types/farming';
import { useDisplayPreferences } from '../../utils/displayPreferences';
import { formatSwtValue, type SwtUnit } from '../../utils/swt';

const FIELDS: Array<{ key: keyof WatermarkCalibrationValues; label: 'pullup' | 'pulldown' | 'seriesFwd' | 'seriesRev'; channel: 1 | 2 }> = [
  { key: 'pullup_1_ohm', label: 'pullup', channel: 1 },
  { key: 'pulldown_1_ohm', label: 'pulldown', channel: 1 },
  { key: 'series_fwd_1_ohm', label: 'seriesFwd', channel: 1 },
  { key: 'series_rev_1_ohm', label: 'seriesRev', channel: 1 },
  { key: 'pullup_2_ohm', label: 'pullup', channel: 2 },
  { key: 'pulldown_2_ohm', label: 'pulldown', channel: 2 },
  { key: 'series_fwd_2_ohm', label: 'seriesFwd', channel: 2 },
  { key: 'series_rev_2_ohm', label: 'seriesRev', channel: 2 },
];

type Draft = Record<keyof WatermarkCalibrationValues, string>;
const EMPTY: Draft = Object.fromEntries(FIELDS.map((f) => [f.key, ''])) as Draft;

function toValues(draft: Draft): WatermarkCalibrationValues | null {
  const out: Partial<WatermarkCalibrationValues> = {};
  for (const f of FIELDS) {
    const n = Number(draft[f.key]);
    if (draft[f.key].trim() === '' || !Number.isFinite(n)) return null;
    out[f.key] = n;
  }
  return out as WatermarkCalibrationValues;
}

function describeChannel(ch: WatermarkPreviewChannel | undefined, t: TFunction<'devices'>, unit: SwtUnit): string {
  if (!ch) return '—';
  if (ch.kpa != null) return formatSwtValue(ch.kpa, unit) ?? `${ch.kpa} kPa`;
  if (ch.status === 'wet_offset_clipped' && ch.kpa_upper_bound != null) {
    return t('watermark.wetUpTo', { value: formatSwtValue(ch.kpa_upper_bound, unit) ?? `${ch.kpa_upper_bound} kPa` });
  }
  return ch.status ? t(`watermark.status.${ch.status}`) : '—';
}

export function WatermarkCalibrationSection({ device, onUpdate }: { device: Device; onUpdate?: () => void }) {
  const { t } = useTranslation('devices');
  const { swtUnit } = useDisplayPreferences();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [syncVersion, setSyncVersion] = useState<number | null>(null);
  const [hasCalibration, setHasCalibration] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const state = await lsn50API.getWatermarkCalibration(device.deveui);
      setSyncVersion(state.sync_version);
      setHasCalibration(state.calibration !== null);
      setDraft(state.calibration
        ? (Object.fromEntries(FIELDS.map((f) => [f.key, String(state.calibration![f.key])])) as Draft)
        : EMPTY);
    } catch {
      setMessage(t('watermark.calibration.loadFailed'));
    }
  }, [device.deveui, t]);

  useEffect(() => { void load(); }, [load]);

  const handleError = async (error: unknown) => {
    if (isAxiosError(error) && error.response?.status === 409) {
      setMessage(t('watermark.calibration.conflict'));
      await load();
      return;
    }
    if (isAxiosError(error) && error.response?.status === 400 && error.response.data?.field) {
      setMessage(t('watermark.calibration.invalidField', { field: error.response.data.field }));
      return;
    }
    setMessage(isAxiosError(error) ? String(error.response?.data?.message ?? error.message) : String(error));
  };

  const values = toValues(draft);

  const onPreview = async () => {
    if (!values) return;
    setBusy(true); setMessage(null);
    try {
      const res = await lsn50API.previewWatermarkCalibration(device.deveui, values);
      setPreview(res.preview
        ? t('watermark.calibration.previewResult', {
            p1: describeChannel(res.preview.channels[0], t, swtUnit),
            p2: describeChannel(res.preview.channels[1], t, swtUnit),
          })
        : t('watermark.calibration.previewEmpty'));
    } catch (error) { await handleError(error); } finally { setBusy(false); }
  };

  const onSave = async () => {
    if (!values || syncVersion === null) return;
    setBusy(true); setMessage(null);
    try {
      const res = await lsn50API.saveWatermarkCalibration(device.deveui, values, syncVersion);
      setSyncVersion(res.sync_version);
      setHasCalibration(true);
      setMessage(t('watermark.calibration.saved', { count: res.backfilled }));
      onUpdate?.();
    } catch (error) { await handleError(error); } finally { setBusy(false); }
  };

  const onDelete = async () => {
    if (syncVersion === null || !window.confirm(t('watermark.calibration.confirmDelete'))) return;
    setBusy(true); setMessage(null);
    try {
      const res = await lsn50API.deleteWatermarkCalibration(device.deveui, syncVersion);
      setSyncVersion(res.sync_version);
      setHasCalibration(false);
      setDraft(EMPTY);
      setMessage(t('watermark.calibration.deleted'));
      onUpdate?.();
    } catch (error) { await handleError(error); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      {[1, 2].map((channel) => (
        <fieldset key={channel} className="grid grid-cols-2 gap-2">
          <legend className="col-span-2 text-xs font-semibold text-[var(--text-secondary)]">{t('watermark.calibration.channel', { n: channel })}</legend>
          {FIELDS.filter((f) => f.channel === channel).map((f) => (
            <label key={f.key} className="text-xs text-[var(--text-secondary)]">
              {t(`watermark.calibration.${f.label}`)}
              <input
                name={f.key}
                inputMode="decimal"
                value={draft[f.key]}
                onChange={(e) => { setDraft((d) => ({ ...d, [f.key]: e.target.value })); setPreview(null); }}
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)]"
              />
            </label>
          ))}
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || !values} onClick={onPreview} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)]">{t('watermark.calibration.preview')}</button>
        <button type="button" disabled={busy || !values || syncVersion === null} onClick={onSave} className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-semibold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60">{t('watermark.calibration.save')}</button>
        {hasCalibration && (
          <button type="button" disabled={busy} onClick={onDelete} className="rounded-md bg-[var(--error-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--error-text)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">{t('watermark.calibration.delete')}</button>
        )}
      </div>
      {preview && <p className="text-xs text-[var(--text-secondary)]">{preview}</p>}
      {message && <p className="text-xs text-[var(--text-secondary)]">{message}</p>}
    </div>
  );
}
