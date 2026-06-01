import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '../../LanguageSwitcher';

interface HistoryMobileHeaderProps {
  onLogout: () => void;
}

export const HistoryMobileHeader: React.FC<HistoryMobileHeaderProps> = ({ onLogout }) => {
  const { t } = useTranslation('history');
  const [open, setOpen] = useState(false);

  return (
    <header className="border-b border-[var(--border)] bg-[var(--header-bg)] px-4 py-3 shadow-sm lg:hidden">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-[var(--header-text)] high-contrast-text">
          {t('history.shell.title')}
        </h1>
        <div className="relative">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="history-mobile-actions"
            aria-label={t('history.mobile.openActions')}
            onClick={() => setOpen((current) => !current)}
            className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-3 py-2 text-lg font-bold leading-none text-[var(--text)]"
          >
            ...
          </button>
          {open && (
            <div
              id="history-mobile-actions"
              role="group"
              aria-label={t('history.mobile.actions')}
              className="absolute right-0 z-20 mt-2 min-w-56 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xl"
            >
              <div className="mb-3 flex justify-center">
                <LanguageSwitcher />
              </div>
              <Link
                to="/dashboard"
                className="block rounded-md border border-[var(--border)] px-3 py-2 text-center text-sm font-bold text-[var(--text)]"
              >
                {t('history.nav.legacyDashboard')}
              </Link>
              <button
                type="button"
                onClick={onLogout}
                className="mt-2 w-full rounded-md border border-[var(--border)] px-3 py-2 text-sm font-bold text-[var(--text)]"
              >
                {t('history.nav.logout')}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
