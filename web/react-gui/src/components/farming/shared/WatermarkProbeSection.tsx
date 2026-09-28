import { useTranslation } from 'react-i18next';
import type { WatermarkChannelLatest } from '../../../types/farming';
import { classifySwtWaterStatus, formatSwtCardValue, type SwtUnit } from '../../../utils/swt';
import { SwtStatusIndicator } from './SwtStatusIndicator';

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
  isCurrent: boolean;
  swtUnit: SwtUnit;
  soilTempC: number | null;
  soilTempMeasured: boolean;
  dieTempC: number | null;
  supplyMv: number | null;
  onOpenHistory?: (key: string) => void;
}

function formatOhm(value: number): string {
  if (value >= 10000) return `${(value / 1000).toFixed(0)} kΩ`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} kΩ`;
  return `${Math.round(value)} Ω`;
}

// A clipped probe is only known to be at most kpa_upper_bound. It is certainly
// wet only when that bound itself classifies as wet; otherwise no colour.
function clippedWaterStatus(bound: number | null) {
  return bound != null && classifySwtWaterStatus(bound) === 'wet' ? 'wet' : null;
}

export function WatermarkProbeSection({
  probes, isCurrent, swtUnit, soilTempC, soilTempMeasured, dieTempC, supplyMv, onOpenHistory,
}: WatermarkProbeSectionProps) {
  const { t } = useTranslation('devices');
  return (
    <div className="grid grid-cols-1 gap-2">
      {probes.map(({ key, label, depthLabel, channel }) => {
        const clipped = channel?.status === 'wet_offset_clipped';
        const kpa = channel?.kpa ?? null;
        const bound = channel?.kpa_upper_bound ?? null;
        const value = kpa !== null
          ? formatSwtCardValue(kpa, swtUnit)
          : clipped && bound !== null
            ? t('watermark.wetUpTo', { value: formatSwtCardValue(bound, swtUnit) })
            : null;
        const waterStatus = !isCurrent ? null : kpa !== null ? classifySwtWaterStatus(kpa) : clipped ? clippedWaterStatus(bound) : null;
        // A clipped reading with no upper bound (the bound resistance is itself
        // beyond range) has no value to promise "at most" against; use the
        // distinct unbounded status text instead of the misleading default.
        const unboundedClipped = clipped && bound === null;
        const details: string[] = [];
        if (channel?.r_solved != null) details.push(t('watermark.resistance', { value: formatOhm(channel.r_solved) }));
        else if (channel?.r_upper_bound != null) details.push(t('watermark.resistanceUpTo', { value: formatOhm(channel.r_upper_bound) }));
        if (channel?.offset_mv != null) details.push(t('watermark.offset', { value: channel.offset_mv.toFixed(0) }));
        return (
          <button
            key={key}
            type="button"
            disabled={!onOpenHistory}
            onClick={() => onOpenHistory?.(key)}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left"
          >
            <span>
              <span className="block text-sm font-semibold text-[var(--text)]">{label}</span>
              <span className="block text-xs text-[var(--text-tertiary)]">{depthLabel || t('watermark.depthUnset')}</span>
              {channel?.status && channel.status !== 'ok' && (
                <span className="block text-xs text-[var(--text-secondary)]">
                  {unboundedClipped ? t('watermark.status.wet_offset_clipped_unbounded') : t(`watermark.status.${channel.status}`)}
                </span>
              )}
              {details.length > 0 && <span className="block text-xs text-[var(--text-tertiary)]">{details.join(' · ')}</span>}
            </span>
            <span className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-lg font-bold tabular-nums text-[var(--text)]">{value ?? '—'}</span>
              <SwtStatusIndicator status={waterStatus} />
            </span>
          </button>
        );
      })}
      <p className="text-xs text-[var(--text-tertiary)]">
        {[
          soilTempMeasured && soilTempC != null ? t('watermark.soilTemp', { value: soilTempC.toFixed(1) }) : t('watermark.soilTempNotMeasured'),
          dieTempC != null ? t('watermark.dieTemp', { value: dieTempC.toFixed(1) }) : null,
          supplyMv != null ? t('watermark.supply', { value: (supplyMv / 1000).toFixed(2) }) : null,
        ].filter(Boolean).join(' · ')}
      </p>
    </div>
  );
}
