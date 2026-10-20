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
  /** Name of the probe family shown beside the section title (a product name, passed in through a locale key). */
  family: string;
  probes: SoilTensionProbe[];
}

/**
 * Below `sm` a tile holds about 100 px of content, so the value steps down a size and may wrap
 * anywhere: a Tensiomark reads up to pF 7, and "150000.0 kPa" must not spill into the next tile.
 * Kept identical to the OSI Cloud component.
 */
const VALUE_CLASS = 'min-w-0 max-w-full text-xl font-bold tabular-nums [overflow-wrap:anywhere] sm:text-2xl';
/** A 44 px touch target; the negative margin keeps the value row at its text height. */
const VALUE_TARGET_CLASS = 'inline-flex min-h-11 -my-1.5 items-center';
const SECONDARY_TARGET_CLASS = 'inline-flex min-h-11 items-center';
const SECONDARY_CLASS = 'text-sm font-semibold text-[var(--text-secondary)]';

function byDepth(left: SoilTensionProbe, right: SoilTensionProbe): number {
  const depth = (probe: SoilTensionProbe) => probe.depthCm ?? Number.POSITIVE_INFINITY;
  return depth(left) - depth(right) || left.channel - right.channel;
}

function SoilTensionTile({ probe }: { probe: SoilTensionProbe }) {
  const { t } = useTranslation('devices');
  const { swtUnit } = useDisplayPreferences();
  const labelId = useId();
  const historyId = useId();
  const formatted = formatSwtCardValue(probe.kpa, swtUnit);
  const invalid = toFiniteSwtValue(probe.kpa) !== null && classifySwtWaterStatus(probe.kpa) === null;
  const channelLabel = t('soilTension.channel', { channel: probe.channel });
  const depthLabel = probe.depthCm === null ? null : t('soilTension.depthCm', { depth: probe.depthCm });
  const historyTitle = t('common.viewHistory');
  const { secondary } = probe;
  const valueOpensHistory = formatted !== null && probe.onOpenHistory !== undefined;
  const hasHistoryButton = valueOpensHistory || secondary?.onOpenHistory !== undefined;
  // Spoken with every history button: which probe, and what the button does (the title is hover-only).
  const historyDescription = `${labelId} ${historyId}`;

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-testid="soil-tension-tile"
      className="row-span-3 grid min-w-0 grid-rows-subgrid gap-y-2 rounded-lg bg-[var(--card)] p-3"
    >
      <p id={labelId} className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
        {channelLabel}
        {depthLabel !== null && <>{' '}<span className="normal-case">{depthLabel}</span></>}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {formatted === null ? (
          <p className={`${VALUE_CLASS} text-[var(--text-tertiary)]`}>—</p>
        ) : valueOpensHistory ? (
          <button
            type="button"
            onClick={probe.onOpenHistory}
            className={`${VALUE_CLASS} ${VALUE_TARGET_CLASS} text-left text-[var(--text)] ${HISTORY_VALUE_CUE} ${FOCUS_VISIBLE_RING}`}
            title={historyTitle}
            aria-describedby={historyDescription}
          >
            {formatted}
          </button>
        ) : (
          <p className={`${VALUE_CLASS} text-[var(--text)]`}>{formatted}</p>
        )}
        <SwtStatusIndicator status={classifySwtWaterStatus(probe.kpa)} />
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1">
        {invalid && (
          <p className="text-xs text-[var(--text-tertiary)]">{t('soilTension.invalidReading')}</p>
        )}
        {formatted === null && !invalid && probe.note && (
          <p className="text-xs text-[var(--text-secondary)]">{probe.note}</p>
        )}
        {secondary && (secondary.onOpenHistory ? (
          <button
            type="button"
            onClick={secondary.onOpenHistory}
            className={`${SECONDARY_TARGET_CLASS} ${SECONDARY_CLASS} text-left ${HISTORY_VALUE_CUE} ${FOCUS_VISIBLE_RING}`}
            title={historyTitle}
            aria-describedby={historyDescription}
          >
            {secondary.text}
          </button>
        ) : (
          <p className={SECONDARY_CLASS}>{secondary.text}</p>
        ))}
        {hasHistoryButton && <span id={historyId} className="sr-only">{historyTitle}</span>}
      </div>
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
        <div data-testid="soil-tension-grid" className="grid grid-cols-2 gap-x-3 gap-y-3">
          {sorted.map((probe) => <SoilTensionTile key={`${probe.channel}-${probe.depthCm ?? 'unknown'}`} probe={probe} />)}
        </div>
      )}
    </section>
  );
}
