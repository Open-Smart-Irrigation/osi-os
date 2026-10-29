import React from 'react';
import { useTranslation } from 'react-i18next';
import { HelpTip } from './shared/HelpTip';
import type { ZoneRainGaugeCandidate, ZoneRainSource } from '../../utils/zoneRainSource';

interface Props {
  id: string;
  /** null while loading or when the load failed. */
  source: ZoneRainSource | null;
  loadFailed: boolean;
  /** '' = no gauge chosen, else a candidate DevEUI. */
  value: string;
  onChange: (value: string) => void;
}

/**
 * "Rain gauge for this zone" (owner decision D1): the gauges that report for
 * the zone, the field journal's pick marked as a suggestion the operator
 * confirms by choosing it; the select starts empty unless the operator chose
 * a gauge before. Hidden for a zone without a gauge.
 */
export const ZoneRainGaugeField: React.FC<Props> = ({ id, source, loadFailed, value, onChange }) => {
  const { t } = useTranslation('devices');
  if (loadFailed) {
    return (
      <p className="text-xs text-[var(--text-tertiary)]">
        {t('zoneRainGauge.loadFailed', { defaultValue: 'The rain gauges of this zone could not be loaded.' })}
      </p>
    );
  }
  if (!source || source.candidates.length === 0) return null;

  const onlyCandidate = source.basis === 'only_candidate'
    && source.candidates.length === 1
    && source.selectedDeveui === source.candidates[0].deveui
    ? source.candidates[0]
    : null;
  const onlyCandidateName = onlyCandidate?.name ?? onlyCandidate?.deveui;

  const optionLabel = (candidate: ZoneRainGaugeCandidate) => {
    const name = candidate.name ?? candidate.deveui;
    const label = candidate.via === 'weather_station'
      ? t('zoneRainGauge.optionShared', { name, defaultValue: '{{name}} (shared weather station)' })
      : name;
    return candidate.deveui === source.suggestedDeveui
      ? t('zoneRainGauge.optionSuggested', { label, defaultValue: '{{label}} — suggested' })
      : label;
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">
          {t('zoneRainGauge.label', { defaultValue: 'Rain gauge for this zone' })}
        </label>
        <HelpTip label={t('zoneRainGauge.helpLabel', { defaultValue: 'About the rain gauge' })}>
          {t('zoneRainGauge.help', {
            defaultValue: "When more than one rain gauge reports for this zone, the zone's daily rain comes from the gauge you choose here. Rain from two gauges is never added. A change recalculates the last 30 days.",
          })}
        </HelpTip>
      </div>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
      >
        <option value="">{onlyCandidateName
          ? t('zoneRainGauge.automaticOption', {
            name: onlyCandidateName,
            defaultValue: 'Automatic: {{name}}',
          })
          : t('zoneRainGauge.notChosen', { defaultValue: '— No gauge chosen —' })}</option>
        {source.candidates.map((candidate) => (
          <option key={candidate.deveui} value={candidate.deveui}>{optionLabel(candidate)}</option>
        ))}
      </select>
      {source.state === 'ambiguous' && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {t('zoneRainGauge.ambiguous', {
            defaultValue: 'Two rain gauges report for this zone. Until you choose one, the zone has no measured rain.',
          })}
        </p>
      )}
      {onlyCandidateName && (
        <p className="mt-2 text-xs text-[var(--text-tertiary)]">
          {t('zoneRainGauge.automaticOnlyCandidate', {
            name: onlyCandidateName,
            defaultValue: 'Automatically using {{name}}, the only rain gauge for this zone.',
          })}
        </p>
      )}
    </div>
  );
};
