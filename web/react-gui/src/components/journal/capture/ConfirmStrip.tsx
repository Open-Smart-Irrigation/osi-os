import { useTranslation } from 'react-i18next';

export type CaptureEditStep = 'where' | 'activity' | 'details';

export interface ConfirmToken {
  label: string;
  value: string;
  step: CaptureEditStep;
}
export interface ConfirmOccurrenceToken extends ConfirmToken {
  timezone: string;
  endTimezone?: string | null;
}

export interface ConfirmValueToken {
  attribute_code: string;
  group_index?: number;
  label: string;
  value: string;
  unit?: string | null;
  step?: CaptureEditStep;
}

export interface ConfirmStripProps {
  activity: ConfirmToken;
  plot: ConfirmToken;
  layout: ConfirmToken;
  occurrence: ConfirmOccurrenceToken;
  values: ConfirmValueToken[];
  onEdit: (step: CaptureEditStep) => void;
  onFinalize: () => void | Promise<void>;
  finalizeDisabled?: boolean;
  validationInFlight?: boolean;
  duplicateInFlight?: boolean;
  saveInFlight?: boolean;
  readOnly?: boolean;
  editDisabled?: boolean;
}

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';

function tokenText(token: ConfirmToken | ConfirmValueToken): string {
  const unit = 'unit' in token && token.unit ? ` ${token.unit}` : '';
  return `${token.label}: ${token.value}${unit}`;
}

function TokenButton({
  token,
  onEdit,
  disabled = false,
}: {
  token: ConfirmToken | ConfirmValueToken;
  onEdit: (step: CaptureEditStep) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-left text-sm text-[var(--text)] transition-colors hover:border-[var(--primary)] ${FOCUS_RING}`}
      onClick={() => { if (!disabled) onEdit(token.step ?? 'details'); }}
      aria-label={tokenText(token)}
    >
      <span className="block text-xs font-bold text-[var(--text-secondary)]">{token.label}</span>
      <span className="mt-1 block font-semibold">
        {token.value}
        {'unit' in token && token.unit ? ` ${token.unit}` : ''}
      </span>
    </button>
  );
}

export function ConfirmStrip({
  activity,
  plot,
  layout,
  occurrence,
  values,
  onEdit,
  onFinalize,
  finalizeDisabled = false,
  validationInFlight = false,
  duplicateInFlight = false,
  saveInFlight = false,
  readOnly = false,
  editDisabled = false,
}: ConfirmStripProps) {
  const { t } = useTranslation('journal');
  const disabled = readOnly || finalizeDisabled || validationInFlight || duplicateInFlight || saveInFlight;
  const tokenDisabled = readOnly || editDisabled || saveInFlight;

  return (
    <section aria-labelledby="journal-confirm-title" className="space-y-5">
      <h2 id="journal-confirm-title" className="text-xl font-bold text-[var(--text)]">
        {t('capture.confirm.title')}
      </h2>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TokenButton token={activity} onEdit={onEdit} disabled={tokenDisabled} />
        <TokenButton token={plot} onEdit={onEdit} disabled={tokenDisabled} />
        <TokenButton token={layout} onEdit={onEdit} disabled={tokenDisabled} />
        <TokenButton token={occurrence} onEdit={onEdit} disabled={tokenDisabled} />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-bold text-[var(--text-secondary)]">
          {t('capture.confirm.values')}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {values.map((value) => (
            <TokenButton key={`${value.attribute_code}:${value.group_index ?? 0}:${value.value}`} token={value} onEdit={onEdit} disabled={tokenDisabled} />
          ))}
        </div>
      </div>

      <p className="rounded-xl bg-[var(--secondary-bg)] px-3 py-2 text-sm text-[var(--text-secondary)]">
        {occurrence.timezone}
        {occurrence.endTimezone && occurrence.endTimezone !== occurrence.timezone
          ? ` → ${occurrence.endTimezone}`
          : ''}
      </p>

      <button
        type="button"
        disabled={disabled}
        onClick={() => void onFinalize()}
        style={{ minHeight: '56px' }}
        className={`min-h-12 w-full rounded-xl bg-[var(--primary)] px-5 py-3 font-bold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
      >
        {t('capture.finish')}
      </button>
    </section>
  );
}
