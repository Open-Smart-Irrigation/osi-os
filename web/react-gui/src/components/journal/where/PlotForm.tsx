import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { JournalPlot, JournalPlotWritePayload } from '../../../types/journal';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';
const TOUCH_CONTROL = 'min-h-[56px]';

export interface PlotFormProps {
  mode: 'create' | 'update';
  initialPlot?: JournalPlot;
  layoutOptions: readonly { code: string; version: number; label: string }[];
  onSubmit: (payload: JournalPlotWritePayload) => Promise<JournalPlot>;
  onAfterSave?: (plot: JournalPlot) => void | Promise<void>;
  onCancel: () => void;
}

interface DomainPayload {
  error?: string;
  message?: string;
}

interface ValidationState {
  plotCode: boolean;
  layout: boolean;
  area: boolean;
}

const VALID_FIELDS: ValidationState = {
  plotCode: false,
  layout: false,
  area: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function domainPayload(error: unknown): DomainPayload {
  if (!isRecord(error)) return {};
  const response = isRecord(error.response) ? error.response : null;
  const responseData = response && isRecord(response.data) ? response.data : null;
  const directData = isRecord(error.data) ? error.data : null;
  const data = responseData ?? directData ?? error;
  return {
    ...(typeof data.error === 'string' ? { error: data.error } : {}),
    ...(typeof data.message === 'string' ? { message: data.message } : {}),
  };
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function plotLayoutCode(
  plot: JournalPlot | undefined,
  layoutOptions: PlotFormProps['layoutOptions'],
): string {
  return layoutOptions.some((option) => option.code === plot?.settings.layout_code)
    ? plot?.settings.layout_code ?? ''
    : '';
}

export function PlotForm(props: PlotFormProps) {
  const identity = props.mode === 'create'
    ? 'create'
    : `update:${props.initialPlot?.plot_uuid ?? ''}`;
  return <PlotFormState key={identity} {...props} />;
}

function PlotFormState({
  mode,
  initialPlot,
  layoutOptions,
  onSubmit,
  onAfterSave,
  onCancel,
}: PlotFormProps) {
  const { t } = useTranslation('journal');
  const instanceId = useId().replace(/:/g, '');
  const idPrefix = `plot-form-${instanceId}`;
  const headingId = `${idPrefix}-heading`;
  const errorId = `${idPrefix}-error`;
  const plotCodeId = `${idPrefix}-code`;
  const nameId = `${idPrefix}-name`;
  const zoneId = `${idPrefix}-zone`;
  const stationId = `${idPrefix}-station`;
  const cropHintId = `${idPrefix}-crop-hint`;
  const areaId = `${idPrefix}-area`;
  const layoutId = `${idPrefix}-layout`;
  const activeId = `${idPrefix}-active`;
  const [plotUuid] = useState(() =>
    mode === 'create' ? crypto.randomUUID() : (initialPlot?.plot_uuid ?? ''),
  );
  const [plotCode, setPlotCode] = useState(initialPlot?.plot_code ?? '');
  const [name, setName] = useState(initialPlot?.name ?? '');
  const [zoneUuid, setZoneUuid] = useState(initialPlot?.zone_uuid ?? '');
  const [stationCode, setStationCode] = useState(initialPlot?.station_code ?? '');
  const [cropHint, setCropHint] = useState(initialPlot?.crop_hint ?? '');
  const [area, setArea] = useState(
    initialPlot?.area_m2 == null ? '' : String(initialPlot.area_m2),
  );
  const [active, setActive] = useState(initialPlot?.active !== 0);
  const [layoutCode, setLayoutCode] = useState(() => plotLayoutCode(initialPlot, layoutOptions));
  const [error, setError] = useState<unknown | null>(null);
  const [validation, setValidation] = useState<ValidationState>(VALID_FIELDS);
  const [submitting, setSubmitting] = useState(false);
  const [committed, setCommitted] = useState(false);
  const plotCodeRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLInputElement>(null);
  const layoutRef = useRef<HTMLSelectElement>(null);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const attemptRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;
    };
  }, []);

  const errorMessage = (failure: unknown): string => {
    const payload = domainPayload(failure);
    const keyByCode: Record<string, { key: string; defaultValue: string }> = {
      plot_code_conflict: {
        key: 'plot.codeConflict',
        defaultValue: 'Plot code is already in use.',
      },
      stale_version: {
        key: 'plot.stale',
        defaultValue: 'This plot changed elsewhere. Reload before saving.',
      },
      heterogeneous_group: {
        key: 'plot.heterogeneousGroup',
        defaultValue: 'The plot belongs to a heterogeneous group.',
      },
      plot_in_unresolved_group: {
        key: 'plot.unresolvedGroup',
        defaultValue: 'Resolve the plot group before deactivating this plot.',
      },
    };
    const mapped = payload.error ? keyByCode[payload.error] : undefined;
    const message = mapped
      ? t(mapped.key, { defaultValue: mapped.defaultValue })
      : t('plot.error', { defaultValue: 'Could not save the plot.' });
    const detail = payload.message && payload.message !== message ? ` ${payload.message}` : '';
    return `${message}${detail}${payload.error ? ` (${payload.error})` : ''}`;
  };

  const submitForm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;

    const selectedLayout = layoutOptions.find((option) => option.code === layoutCode);
    const numericArea = area.trim() === '' ? null : Number(area);
    const nextValidation: ValidationState = {
      plotCode: plotCode.trim() === '',
      layout: !selectedLayout,
      area: numericArea !== null && (!Number.isFinite(numericArea) || numericArea <= 0),
    };
    setValidation(nextValidation);

    if (nextValidation.plotCode) {
      plotCodeRef.current?.focus();
    } else if (nextValidation.area) {
      areaRef.current?.focus();
    } else if (nextValidation.layout) {
      layoutRef.current?.focus();
    }

    if (!selectedLayout) {
      setError(t('plot.layoutRequired', {
        defaultValue: 'Select an active layout before saving.',
      }));
      return;
    }

    if (nextValidation.plotCode || nextValidation.area) {
      setError(null);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const attempt = attemptRef.current;
    const payload: JournalPlotWritePayload = {
      plot_uuid: plotUuid,
      base_sync_version: mode === 'create' ? 0 : (initialPlot?.sync_version ?? 0),
      plot_code: plotCode.trim(),
      name: nullableText(name),
      zone_uuid: nullableText(zoneUuid),
      station_code: nullableText(stationCode),
      crop_hint: nullableText(cropHint),
      area_m2: Number.isFinite(numericArea) ? numericArea : null,
      active: active ? 1 : 0,
      layout_code: selectedLayout.code,
      layout_version: selectedLayout.version,
    };

    try {
      const savedPlot = await onSubmit(payload);
      if (!mountedRef.current || attemptRef.current !== attempt) return;
      setSubmitting(false);
      setCommitted(true);
      try {
        await onAfterSave?.(savedPlot);
      } catch {
        // The mutation is committed; keep the form locked without surfacing a
        // misleading mutation failure or creating an unhandled rejection.
      }
    } catch (failure: unknown) {
      if (!mountedRef.current || attemptRef.current !== attempt) return;
      setError(errorMessage(failure));
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const plotCodeLabel = t('plot.code', { defaultValue: 'Plot code' });
  const areaLabel = t('plot.area', { defaultValue: 'Area (m²)' });
  const plotCodeErrorId = `${plotCodeId}-error`;
  const areaErrorId = `${areaId}-error`;
  const controlsDisabled = submitting || committed;
  const labelClass = `mb-2 block ${TOUCH_CONTROL} flex items-center text-sm font-bold text-[var(--text)]`;
  const inputClass = `w-full ${TOUCH_CONTROL} min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] outline-none ${FOCUS_RING}`;

  return (
    <form
      onSubmit={submitForm}
      className="w-full min-w-0 space-y-5"
      aria-labelledby={headingId}
      aria-describedby={error !== null ? errorId : undefined}
    >
      <h2 id={headingId} className="text-xl font-bold text-[var(--text)]">
        {t(mode === 'create' ? 'plot.new' : 'plot.edit', {
          defaultValue: mode === 'create' ? 'New plot' : 'Edit plot',
        })}
      </h2>

      {error !== null && (
        <p id={errorId} role="alert" className="min-w-0 break-words rounded-xl bg-[var(--error-bg)] px-3 py-3 font-semibold text-[var(--error-text)]">
          {typeof error === 'string' ? error : errorMessage(error)}
        </p>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor={plotCodeId} className={labelClass}>
            {plotCodeLabel}
          </label>
          <input
            id={plotCodeId}
            ref={plotCodeRef}
            className={inputClass}
            value={plotCode}
            required
            disabled={controlsDisabled}
            aria-invalid={validation.plotCode ? 'true' : undefined}
            aria-describedby={validation.plotCode ? plotCodeErrorId : (error !== null ? errorId : undefined)}
            onChange={(event) => {
              setPlotCode(event.target.value);
              setValidation((current) => ({ ...current, plotCode: false }));
            }}
          />
          {validation.plotCode && (
            <p id={plotCodeErrorId} className="mt-2 text-sm font-semibold text-[var(--error-text)]">
              {plotCodeLabel} *
            </p>
          )}
        </div>

        <div className="min-w-0">
          <label htmlFor={nameId} className={labelClass}>
            {t('plot.name', { defaultValue: 'Name' })}
          </label>
          <input id={nameId} className={inputClass} value={name} disabled={controlsDisabled} onChange={(event) => setName(event.target.value)} />
        </div>

        <div className="min-w-0">
          <label htmlFor={zoneId} className={labelClass}>
            {t('plot.zone', { defaultValue: 'Zone' })}
          </label>
          <input id={zoneId} className={inputClass} value={zoneUuid} disabled={controlsDisabled} onChange={(event) => setZoneUuid(event.target.value)} />
        </div>

        <div className="min-w-0">
          <label htmlFor={stationId} className={labelClass}>
            {t('plot.station', { defaultValue: 'Station' })}
          </label>
          <input id={stationId} className={inputClass} value={stationCode} disabled={controlsDisabled} onChange={(event) => setStationCode(event.target.value)} />
        </div>

        <div className="min-w-0">
          <label htmlFor={cropHintId} className={labelClass}>
            {t('plot.cropHint', { defaultValue: 'Crop hint' })}
          </label>
          <input id={cropHintId} className={inputClass} value={cropHint} disabled={controlsDisabled} onChange={(event) => setCropHint(event.target.value)} />
        </div>

        <div className="min-w-0">
          <label htmlFor={areaId} className={labelClass}>
            {areaLabel}
          </label>
          <input
            id={areaId}
            ref={areaRef}
            type="text"
            inputMode="decimal"
            className={inputClass}
            value={area}
            disabled={controlsDisabled}
            aria-invalid={validation.area ? 'true' : undefined}
            aria-describedby={validation.area ? areaErrorId : (error !== null ? errorId : undefined)}
            onChange={(event) => {
              setArea(event.target.value);
              setValidation((current) => ({ ...current, area: false }));
            }}
          />
          {validation.area && (
            <p id={areaErrorId} className="mt-2 text-sm font-semibold text-[var(--error-text)]">
              {areaLabel}: &gt; 0
            </p>
          )}
        </div>

        <div className="min-w-0">
          <label htmlFor={layoutId} className={labelClass}>
            {t('plot.layout', { defaultValue: 'Layout' })}
          </label>
          <select
            id={layoutId}
            ref={layoutRef}
            className={inputClass}
            value={layoutCode}
            required
            disabled={controlsDisabled}
            aria-invalid={validation.layout ? 'true' : undefined}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(event) => {
              setLayoutCode(event.target.value);
              setValidation((current) => ({ ...current, layout: false }));
            }}
          >
            <option value="">{t('plot.layoutRequired', { defaultValue: 'Select an active layout' })}</option>
            {layoutOptions.map((option) => (
              <option key={`${option.code}:${option.version}`} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0">
          <label htmlFor={activeId} className={labelClass}>
            <input
              id={activeId}
              type="checkbox"
              checked={active}
              disabled={controlsDisabled}
              onChange={(event) => setActive(event.target.checked)}
              className={`mr-3 size-6 ${TOUCH_CONTROL} ${FOCUS_RING}`}
            />
            {t('plot.active', { defaultValue: 'Active' })}
          </label>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap gap-3 pt-2">
        <button type="button" onClick={onCancel} disabled={submitting} className={`flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 font-bold text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-60 ${TOUCH_CONTROL} ${FOCUS_RING}`}>
          {t('plot.cancel', { defaultValue: 'Cancel' })}
        </button>
        <button type="submit" disabled={submitting || committed} className={`flex-1 rounded-xl bg-[var(--primary)] px-4 py-2 font-bold text-white disabled:cursor-not-allowed disabled:opacity-60 ${TOUCH_CONTROL} ${FOCUS_RING}`}>
          {submitting
            ? t('plot.loading', { defaultValue: 'Saving…' })
            : t('plot.save', { defaultValue: 'Save' })}
        </button>
      </div>
    </form>
  );
}
