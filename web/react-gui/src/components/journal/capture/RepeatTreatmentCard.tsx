import React from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { sameCarryForwardContext } from '../../../journal/carryForward';
import { catalogLabel } from '../../../journal/catalogModel';
import type {
  CarryForwardCandidate,
  CarryForwardContext,
} from '../../../journal/carryForward';
import type { JournalProductRow, JournalVocabRow, ValueStatus } from '../../../types/journal';
import type { CaptureEntryValueInput, JournalScalar } from '../../../types/journalCapture';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';

const VALUE_STATUS_KEYS: Record<ValueStatus, `capture.carry.valueStatus.${ValueStatus}`> = {
  observed: 'capture.carry.valueStatus.observed',
  not_observed: 'capture.carry.valueStatus.not_observed',
  not_applicable: 'capture.carry.valueStatus.not_applicable',
  below_detection: 'capture.carry.valueStatus.below_detection',
};

export interface RepeatTreatmentCardProps {
  candidate: CarryForwardCandidate;
  currentContext: CarryForwardContext;
  catalog?: {
    products: Array<Pick<JournalProductRow, 'product_uuid' | 'name'>>;
    vocab: Array<Pick<JournalVocabRow, 'code' | 'kind' | 'labels'>>;
  };
  accepted?: boolean;
  onConfirm: (values: CaptureEntryValueInput[]) => void;
  onDismiss: () => void;
}

function disclosedValue(
  value: CaptureEntryValueInput,
  catalog: NonNullable<RepeatTreatmentCardProps['catalog']>,
  locale: string,
  t: TFunction<'journal'>,
): string {
  const statusKey = typeof value.value_status === 'string'
    ? VALUE_STATUS_KEYS[value.value_status as ValueStatus]
    : undefined;
  const statusLabel = value.value_status == null
    ? null
    : statusKey ? t(statusKey) : t('capture.carry.unknownValue');
  const groupIndex = value.group_index ?? 0;
  const attribute = catalog.vocab.find((row) => row.code === value.attribute_code);
  const resolvedAttributeLabel = attribute ? catalogLabel(attribute, locale) : null;
  const attributeLabel = resolvedAttributeLabel && resolvedAttributeLabel !== value.attribute_code
    ? resolvedAttributeLabel
    : t('capture.carry.unknownValue');
  const group = ` · ${t('capture.carry.group', { number: groupIndex + 1 })}`;
  if (value.value_status != null && value.value_status !== 'observed') {
    return `${attributeLabel}${group}: ${statusLabel}`;
  }

  let raw: JournalScalar | string | null | undefined =
    value.value_text ?? value.value ?? value.entered_value_num ?? value.value_num ?? statusLabel ?? '—';
  if (value.attribute_code === 'attr.product_uuid') {
    const productCode = value.value_text ?? value.value;
    const product = typeof productCode === 'string'
      ? catalog.products.find((candidate) => candidate.product_uuid === productCode)
      : undefined;
    raw = product?.name ?? t('capture.carry.unknownProduct');
  }
  const choiceCode = value.value ?? value.value_text;
  const choice = typeof choiceCode === 'string'
    ? catalog.vocab.find((row) => row.code === choiceCode && row.kind === 'choice')
    : undefined;
  if (choice) {
    const choiceLabel = catalogLabel(choice, locale);
    raw = choiceLabel === choice.code ? t('capture.carry.unknownValue') : choiceLabel;
  } else if (typeof choiceCode === 'string' && choiceCode.startsWith('choice.')) {
    raw = t('capture.carry.unknownValue');
  }
  const unitCode = value.entered_unit_code ?? value.unit_code;
  const unit = unitCode
    ? catalog.vocab.find((row) => row.code === unitCode && row.kind === 'unit')
    : undefined;
  const resolvedUnitLabel = unit ? catalogLabel(unit, locale) : null;
  const unitLabel = unitCode
    ? resolvedUnitLabel && resolvedUnitLabel !== unitCode
      ? resolvedUnitLabel
      : t('capture.carry.unknownValue')
    : null;
  return `${attributeLabel}${group}: ${String(raw)}${unitLabel ? ` ${unitLabel}` : ''}`;
}

function sourceDateLabel(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

export const RepeatTreatmentCard: React.FC<RepeatTreatmentCardProps> = ({
  candidate,
  currentContext,
  catalog,
  accepted = false,
  onConfirm,
  onDismiss,
}) => {
  const { t, i18n } = useTranslation('journal');
  const treatment = candidate.repeatTreatment;
  const catalogData = catalog ?? { products: [], vocab: [] };
  const contextInvalidated = treatment == null ||
    !sameCarryForwardContext(candidate.context, currentContext);
  const missingSafetyFacts = treatment?.complete === false;
  const unavailable = contextInvalidated || missingSafetyFacts;

  if (!treatment) return null;

  const locale = i18n.resolvedLanguage || i18n.language || 'en';

  const confirm = () => {
    if (unavailable || accepted) return;
    onConfirm(treatment.values);
  };

  return (
    <article
      aria-label={t('capture.carry.repeatTreatment')}
      className="space-y-4 rounded-2xl border border-dashed border-[var(--primary)] bg-[var(--card)] p-4"
    >
      <div>
        <h2 className="text-base font-bold text-[var(--text)]">
          {t('capture.carry.repeatTreatment')}
        </h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          {t('capture.carry.repeatTreatmentDescription')}
        </p>
      </div>

      {unavailable ? (
        <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {t(missingSafetyFacts
            ? 'capture.validation.invalidDefinition'
            : 'capture.carry.invalidated')}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-bold text-[var(--text-secondary)]">
                {t('capture.carry.sourceDate')}
              </dt>
              <dd>
                <time dateTime={treatment.sourceDate}>
                  {sourceDateLabel(treatment.sourceDate, locale)}
                </time>
              </dd>
            </div>
            <div>
              <dt className="font-bold text-[var(--text-secondary)]">
                {t('capture.carry.crop')}
              </dt>
              <dd>{treatment.crop}</dd>
            </div>
          </dl>
          {treatment.values.length > 0 && (
            <ul aria-label={t('capture.carry.protectedValues')} className="space-y-1 text-xs text-[var(--text-secondary)]">
              {treatment.values.map((value, index) => (
                <li key={`${value.attribute_code}:${value.group_index ?? 0}:${index}`}>
                  {disclosedValue(value, catalogData, locale, t)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {!unavailable && (
          <button
            type="button"
            disabled={accepted}
            onClick={confirm}
            className={`min-h-11 rounded-xl border border-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
          >
            {t('capture.carry.useValues')}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className={`min-h-11 rounded-xl px-4 py-2 text-sm font-bold text-[var(--text-secondary)] transition-colors hover:bg-[var(--secondary-bg)] ${FOCUS_RING}`}
        >
          {t('capture.carry.dismiss')}
        </button>
      </div>
    </article>
  );
};
