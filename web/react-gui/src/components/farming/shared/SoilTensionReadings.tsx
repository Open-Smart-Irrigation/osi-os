import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { classifySwtWaterStatus, formatSwtCardValue, toFiniteSwtValue } from '../../../utils/swt';
import { useDisplayPreferences } from '../../../utils/displayPreferences';
import { FOCUS_VISIBLE_RING, HISTORY_VALUE_CUE } from './cardHistory';
import { SwtStatusIndicator } from './SwtStatusIndicator';

export interface SoilTensionProbe {
  /** Canonical channel: the probe reads `swt_<channel>`. */
  channel: number;
  /** Installation depth; null when unknown. */
  depthCm: number | null;
  /** Latest stored tension in kPa, unvalidated. */
  kpa: unknown;
  /** Opens the value's history chart. Without it the value is plain text. */
  onOpenHistory?: () => void;
  /** One extra line under the value, e.g. the probe's soil temperature. */
  secondary?: { text: string; onOpenHistory?: () => void } | null;
  /**
   * Gateway-only probe diagnosis shown under a missing value (the WATERMARK probe status, such
   * as "Calibration needed"). The cloud never receives it, so its card has no such line.
   */
  note?: string | null;
}

interface SoilTensionReadingsProps {
  /** Product name of the probe family, shown beside the section title. */
  family: string;
  probes: SoilTensionProbe[];
}

const VALUE_CLASS = 'text-2xl font-bold tabular-nums';
const SECONDARY_CLASS = 'mt-1 text-sm font-semibold text-[var(--text-secondary)]';

function byDepth(left: SoilTensionProbe, right: SoilTensionProbe): number {
  const depth = (probe: SoilTensionProbe) => probe.depthCm ?? Number.POSITIVE_INFINITY;
  return depth(left) - depth(right) || left.channel - right.channel;
}

function SoilTensionTile({ probe }: { probe: SoilTensionProbe }) {
  const { t } = useTranslation('devices');
  const { swtUnit } = useDisplayPreferences();
  const labelId = useId();
  const formatted = formatSwtCardValue(probe.kpa, swtUnit);
  const invalid = toFiniteSwtValue(probe.kpa) !== null && classifySwtWaterStatus(probe.kpa) === null;
  const label = probe.depthCm === null
    ? t('soilTension.channel', { channel: probe.channel })
    : t('soilTension.channelAtDepth', { channel: probe.channel, depth: probe.depthCm });
  const historyTitle = t('common.viewHistory');
  const { secondary } = probe;

  return (
    <div role="group" aria-labelledby={labelId} data-testid="soil-tension-tile" className="min-w-0 rounded-lg bg-[var(--card)] p-3">
      <p id={labelId} className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        {formatted === null ? (
          <p className={`${VALUE_CLASS} text-[var(--text-tertiary)]`}>—</p>
        ) : probe.onOpenHistory ? (
          <button
            type="button"
            onClick={probe.onOpenHistory}
            className={`${VALUE_CLASS} text-left text-[var(--text)] ${HISTORY_VALUE_CUE} ${FOCUS_VISIBLE_RING}`}
            title={historyTitle}
          >
            {formatted}
          </button>
        ) : (
          <p className={`${VALUE_CLASS} text-[var(--text)]`}>{formatted}</p>
        )}
        <SwtStatusIndicator status={classifySwtWaterStatus(probe.kpa)} />
      </div>
      {invalid && (
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('soilTension.invalidReading')}</p>
      )}
      {formatted === null && !invalid && probe.note && (
        <p className="mt-1 text-xs text-[var(--text-secondary)]">{probe.note}</p>
      )}
      {secondary && (secondary.onOpenHistory ? (
        <button
          type="button"
          onClick={secondary.onOpenHistory}
          className={`${SECONDARY_CLASS} text-left ${HISTORY_VALUE_CUE} ${FOCUS_VISIBLE_RING}`}
          title={historyTitle}
        >
          {secondary.text}
        </button>
      ) : (
        <p className={SECONDARY_CLASS}>{secondary.text}</p>
      ))}
    </div>
  );
}

/**
 * The one soil tension block of a device card, shared by every probe family (WATERMARK on an
 * LSN50, Tensiomark on SDI-12) and kept in step with the OSI Cloud component of the same name:
 * a titled section with one tile per probe, ordered by depth, each with its latest stored value
 * (kPa or pF per the display preference) and its water-status pill. There is no freshness rule:
 * the pill follows the latest stored value and the card's last-seen line carries the age. A
 * missing value shows "—"; a value outside the displayable range shows "—" and "Invalid
 * reading"; neither gets a pill or a history link.
 */
export function SoilTensionReadings({ family, probes }: SoilTensionReadingsProps) {
  const { t } = useTranslation('devices');
  const title = t('soilTension.sectionTitle');
  const sorted = [...probes].sort(byDepth);

  return (
    <section data-testid="soil-tension-readings" aria-label={title} className="mt-4 border-t border-[var(--border)] pt-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--text-secondary)]">{title}</h3>
        <span className="truncate text-xs font-semibold tracking-wide text-[var(--text-tertiary)]">{family}</span>
      </div>
      {sorted.length === 0 ? (
        <p className="rounded-lg bg-[var(--card)] px-3 py-4 text-sm text-[var(--text-tertiary)]">{t('soilTension.noReadings')}</p>
      ) : (
        <div data-testid="soil-tension-grid" className="grid grid-cols-2 gap-3">
          {sorted.map((probe) => <SoilTensionTile key={probe.channel} probe={probe} />)}
        </div>
      )}
    </section>
  );
}
