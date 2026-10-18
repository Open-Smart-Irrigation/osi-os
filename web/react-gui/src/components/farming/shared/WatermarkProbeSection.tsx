import { useTranslation } from 'react-i18next';
import type { WatermarkChannelLatest } from '../../../types/farming';
import { classifySwtWaterStatus, formatSwtCardValue, type SwtUnit } from '../../../utils/swt';
import { SwtStatusIndicator } from './SwtStatusIndicator';
import { FOCUS_VISIBLE_RING, HISTORY_VALUE_CUE } from './cardHistory';

// Node-neutral view of IRROMETER WATERMARK 200SS probes. The LSN50 card uses it
// now; the KIWI card can embed it later (spec D5). Physics stays on the edge:
// this component only formats what the helper computed.
export interface WatermarkProbeView {
  key: string;
  label: string;
  depthLabel: string | null;
  channel: WatermarkChannelLatest | null;
}

interface WatermarkProbeSectionProps {
  probes: WatermarkProbeView[];
  swtUnit: SwtUnit;
  soilTempC: number | null;
  dieTempC: number | null;
  supplyMv: number | null;
  // Opens the card history view for a series: a probe key (swt_1, swt_2) or
  // 'ext_temperature_c' for the measured soil temperature.
  onOpenHistory?: (key: string) => void;
}

export function WatermarkProbeSection({
  probes, swtUnit, soilTempC, onOpenHistory,
}: WatermarkProbeSectionProps) {
  const { t } = useTranslation('devices');
  const historyTitle = onOpenHistory ? t('common.viewHistory', { defaultValue: 'View history' }) : undefined;
  const soilTempText = soilTempC != null ? t('watermark.soilTemp', { value: soilTempC.toFixed(1) }) : null;
  return (
    <div className="grid grid-cols-1 gap-2">
      {probes.map(({ key, label, depthLabel, channel }, index) => {
        const kpa = channel?.kpa ?? null;
        const value = formatSwtCardValue(kpa, swtUnit);
        const waterStatus = classifySwtWaterStatus(kpa);
        const unboundedClipped = channel?.status === 'wet_offset_clipped' && channel.kpa_upper_bound == null;
        return (
          <div
            key={key}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
          >
            <span>
              <span className="block text-sm font-semibold text-[var(--text)]">{label}</span>
              <span className="block text-xs text-[var(--text-tertiary)]">{depthLabel || t('watermark.depthUnset')}</span>
              {kpa === null && channel?.status && channel.status !== 'ok' && (
                <span className="block text-xs text-[var(--text-secondary)]">
                  {unboundedClipped ? t('watermark.status.wet_offset_clipped_unbounded') : t(`watermark.status.${channel.status}`)}
                </span>
              )}
            </span>
            <span className="flex flex-wrap items-center justify-end gap-2">
              {value !== null && onOpenHistory ? (
                <button type="button" onClick={() => onOpenHistory(key)} title={historyTitle} className={`text-lg font-bold tabular-nums text-[var(--text)] ${HISTORY_VALUE_CUE} ${FOCUS_VISIBLE_RING}`}>{value}</button>
              ) : <span className="text-lg font-bold tabular-nums text-[var(--text)]">{value ?? '—'}</span>}
              {index === 0 && soilTempText !== null && (
                <button type="button" onClick={() => onOpenHistory?.('ext_temperature_c')} disabled={!onOpenHistory} title={historyTitle} className={`text-sm font-semibold text-[var(--text-secondary)] ${onOpenHistory ? `${HISTORY_VALUE_CUE} ${FOCUS_VISIBLE_RING}` : ''}`}>{soilTempText}</button>
              )}
              <SwtStatusIndicator status={waterStatus} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
