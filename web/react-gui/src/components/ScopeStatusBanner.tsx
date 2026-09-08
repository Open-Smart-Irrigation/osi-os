import { useTranslation } from 'react-i18next';
import { useScope } from '../contexts/ScopeContext';

export function ScopeStatusBanner() {
  const { t } = useTranslation('common');
  const { error, retry } = useScope();

  if (!error) return null;

  return (
    <div
      role="alert"
      className="flex items-center justify-center gap-3 border-b border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-center text-sm font-semibold text-[var(--danger-text)]"
    >
      <span>{t('scope.loadError')}</span>
      <button
        type="button"
        className="rounded border border-current px-3 py-1 hover:bg-black/5"
        onClick={retry}
      >
        {t('retry')}
      </button>
    </div>
  );
}
