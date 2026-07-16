import { useTranslation } from 'react-i18next';

import type { CaptureSaveState } from '../../../journal/useCaptureDraft';

export interface SaveStateProps {
  status: CaptureSaveState;
  lossWarning?: boolean;
  onRetry?: () => void | Promise<void>;
}

const STATUS_KEYS = {
  saving: 'capture.save.saving',
  'draft-saved-gateway': 'capture.save.draftSavedGateway',
  'final-saved-gateway': 'capture.save.finalSavedGateway',
  'cloud-waiting': 'capture.save.cloudWaiting',
  'not-saved': 'capture.save.notSaved',
} as const satisfies Record<CaptureSaveState, string>;

export function SaveState({ status, lossWarning = false, onRetry }: SaveStateProps) {
  const { t } = useTranslation('journal');
  const canRetry = status === 'not-saved' && onRetry != null;
  const retry = () => {
    if (!onRetry) return;
    try {
      const attempt = onRetry();
      if (attempt) void attempt.catch(() => undefined);
    } catch {
      // The visible state remains "not saved" until the parent reports success.
    }
  };

  return (
    <div className="space-y-2" data-save-state={status}>
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="text-sm font-semibold text-[var(--text-secondary)]"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {t(STATUS_KEYS[status])}
        </span>
        {canRetry && (
          <button
            type="button"
            onClick={retry}
            className="min-h-11 rounded-lg px-3 text-sm font-bold text-[var(--primary)] underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
          >
            {t('capture.save.retry')}
          </button>
        )}
      </div>
      {lossWarning && (
        <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {t('capture.save.lossWarning')}
        </p>
      )}
    </div>
  );
}
