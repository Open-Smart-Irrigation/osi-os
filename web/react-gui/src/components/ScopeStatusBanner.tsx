import { useTranslation } from 'react-i18next';
import { useScope } from '../contexts/ScopeContext';
import { Banner } from '../ui-core';

export function ScopeStatusBanner() {
  const { t } = useTranslation('common');
  const { error, retry } = useScope();

  if (!error) return null;

  return (
    <Banner tone="error" className="flex items-center justify-center gap-3">
      <span>{t('scope.loadError')}</span>
      <button
        type="button"
        className="rounded border border-current px-3 py-1 hover:bg-black/5"
        onClick={retry}
      >
        {t('retry')}
      </button>
    </Banner>
  );
}
