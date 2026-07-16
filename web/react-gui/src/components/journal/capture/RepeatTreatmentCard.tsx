import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  sameCarryForwardContext,
} from '../../../journal/carryForward';
import type {
  CarryForwardCandidate,
  CarryForwardContext,
} from '../../../journal/carryForward';
import type { CaptureEntryValueInput } from '../../../types/journalCapture';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';

export interface RepeatTreatmentCardProps {
  candidate: CarryForwardCandidate;
  currentContext: CarryForwardContext;
  onConfirm: (values: CaptureEntryValueInput[]) => void;
  onInvalidate: (values: CaptureEntryValueInput[]) => void;
  onDismiss: () => void;
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
  onConfirm,
  onInvalidate,
  onDismiss,
}) => {
  const { t, i18n } = useTranslation('journal');
  const treatment = candidate.repeatTreatment;
  const candidateKey = treatment?.sourceEntryUuid ?? null;
  const contextInvalidated = treatment == null ||
    !sameCarryForwardContext(candidate.context, currentContext);
  const missingSafetyFacts = treatment?.complete === false;
  const unavailable = contextInvalidated || missingSafetyFacts;
  const confirmed = useRef<{
    candidateKey: string;
    values: CaptureEntryValueInput[];
  } | null>(null);
  const [acceptedCandidateKey, setAcceptedCandidateKey] = useState<string | null>(null);

  useEffect(() => {
    const accepted = confirmed.current;
    if (!accepted || (!unavailable && accepted.candidateKey === candidateKey)) return;
    confirmed.current = null;
    setAcceptedCandidateKey(null);
    onInvalidate(accepted.values);
  }, [candidateKey, onInvalidate, unavailable]);

  if (!treatment) return null;

  const locale = i18n.resolvedLanguage || i18n.language || 'en';
  const accepted = acceptedCandidateKey === candidateKey;

  const confirm = () => {
    if (unavailable || confirmed.current?.candidateKey === candidateKey) return;
    if (confirmed.current) onInvalidate(confirmed.current.values);
    confirmed.current = { candidateKey: treatment.sourceEntryUuid, values: treatment.values };
    setAcceptedCandidateKey(treatment.sourceEntryUuid);
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
          <div>
            <dt className="font-bold text-[var(--text-secondary)]">
              {t('capture.carry.product')}
            </dt>
            <dd>{treatment.product}</dd>
          </div>
          <div>
            <dt className="font-bold text-[var(--text-secondary)]">
              {t('capture.carry.rate')}
            </dt>
            <dd>{treatment.rate}</dd>
          </div>
        </dl>
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
