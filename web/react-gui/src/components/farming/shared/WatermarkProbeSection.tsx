import { useTranslation } from 'react-i18next';
import type { WatermarkChannelLatest } from '../../../types/farming';
import { useFormatNumber } from '../../../utils/number';
import { SoilTensionReadings, type SoilTensionProbe } from './SoilTensionReadings';

// Node-neutral view of IRROMETER WATERMARK 200SS probes. The LSN50 card uses it
// now; the KIWI card can embed it later (spec D5). Physics stays on the edge:
// this component only formats what the helper computed.
export interface WatermarkProbeView {
  /** Canonical channel: the probe is `swt_<channel>`. */
  channel: 1 | 2;
  /** Installation depth; null when unknown. */
  depthCm: number | null;
  reading: WatermarkChannelLatest | null;
}

interface WatermarkProbeSectionProps {
  probes: WatermarkProbeView[];
  /** The node's one soil temperature (DS18B20), shown under probe 1. */
  soilTempC: number | null;
  // Opens the card history view for a series: a probe key (swt_1, swt_2) or
  // 'ext_temperature_c' for the measured soil temperature.
  onOpenHistory?: (key: string) => void;
}

/**
 * The WATERMARK probes in the soil tension layout every probe family shares
 * (SoilTensionReadings). A probe without kPa keeps its gateway-only status
 * line ("Calibration needed", "Short circuit", …); electrical diagnostics stay
 * off the ordinary card.
 */
export function WatermarkProbeSection({ probes, soilTempC, onOpenHistory }: WatermarkProbeSectionProps) {
  const { t } = useTranslation('devices');
  const formatNumber = useFormatNumber();
  const note = (reading: WatermarkChannelLatest | null): string | null => {
    if (!reading?.status || reading.status === 'ok' || reading.kpa !== null) return null;
    return reading.status === 'wet_offset_clipped' && reading.kpa_upper_bound == null
      ? t('watermark.status.wet_offset_clipped_unbounded')
      : t(`watermark.status.${reading.status}`);
  };
  const tiles: SoilTensionProbe[] = probes.map(({ channel, depthCm, reading }) => ({
    channel,
    depthCm,
    kpa: reading?.kpa ?? null,
    note: note(reading),
    onOpenHistory: onOpenHistory ? () => onOpenHistory(`swt_${channel}`) : undefined,
    secondary: channel === 1 && soilTempC != null
      ? {
        text: t('soilTension.soilTemp', { value: formatNumber(soilTempC, 1) }),
        onOpenHistory: onOpenHistory ? () => onOpenHistory('ext_temperature_c') : undefined,
      }
      : null,
  }));
  return <SoilTensionReadings family={t('soilTension.family.watermark')} probes={tiles} />;
}
