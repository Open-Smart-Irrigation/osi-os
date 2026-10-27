import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ValveControlHelp } from './ValveControlHelp';

const PRESETS = [
  { value: 20, key: 'wet' },
  { value: 30, key: 'moist' },
  { value: 50, key: 'dry' },
] as const;

export interface SwtPreferenceProps { value: number; onChange: (value: number) => void }

export const SwtPreference: React.FC<SwtPreferenceProps> = ({ value, onChange }) => {
  const id = useId();
  const { t } = useTranslation('valves');
  const inputRef = useRef<HTMLInputElement>(null);
  const selectionChangeRef = useRef<{ value: number } | null>(null);
  const [customSelected, setCustomSelected] = useState(!PRESETS.some(option => option.value === value));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    const localSelection = selectionChangeRef.current;
    selectionChangeRef.current = null;
    if (localSelection && Object.is(localSelection.value, value)) {
      return;
    }
    setCustomSelected(!PRESETS.some(option => option.value === value));
  }, [value]);
  useEffect(() => { if (customSelected && advancedOpen) inputRef.current?.focus(); }, [advancedOpen, customSelected]);
  const customLabel = t('irrigationPreference.customThreshold');
  return <fieldset className="relative mt-3 text-[var(--text)]">
    <legend className="text-[var(--text-secondary)] text-sm font-semibold">{t('irrigationPreference.legend')}</legend>
    <div className="mt-2 flex flex-wrap items-center gap-3">
      {PRESETS.map(option => <span key={option.value} className="inline-flex items-center gap-1"><label className="inline-flex min-h-11 items-center gap-2 cursor-pointer"><input type="radio" name={`swt-preference-${id}`} checked={!customSelected && value === option.value} onChange={() => { selectionChangeRef.current = { value: option.value }; setCustomSelected(false); onChange(option.value); }} /><span>{t(`irrigationPreference.${option.key}.label`)}</span></label><ValveControlHelp label={t(`irrigationPreference.${option.key}.about`)}>{t(`irrigationPreference.${option.key}.help`)}</ValveControlHelp></span>)}
      <label className="inline-flex min-h-11 items-center gap-2 cursor-pointer"><input type="radio" name={`swt-preference-${id}`} checked={customSelected} onChange={() => { selectionChangeRef.current = { value }; setCustomSelected(true); setAdvancedOpen(true); }} /><span>{t('irrigationPreference.custom')}</span></label>
    </div>
    <details open={advancedOpen} className="mt-2" onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-[var(--text-secondary)]">{t('irrigationPreference.advancedThreshold')}</summary>
      <label htmlFor={`swt-custom-threshold-${id}`} className="mt-2 block text-xs text-[var(--text-secondary)]">{customLabel}</label>
      <input ref={inputRef} id={`swt-custom-threshold-${id}`} type="number" value={Number.isNaN(value) ? '' : value} onChange={event => { const nextValue = Number(event.target.value); selectionChangeRef.current = { value: nextValue }; setCustomSelected(true); onChange(nextValue); }} max="300" step="any" className="mt-1 w-full px-3 py-2 bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]" />
    </details>
  </fieldset>;
};
