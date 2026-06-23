import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HeaderMenu } from './HeaderMenu';
import { LanguageSwitcher } from './LanguageSwitcher';
import { isDesktopBrowser } from '../utils/isDesktopBrowser';

interface DashboardHeaderProps {
  username: string | null;
  onAddZone: () => void;
  onAddDevice: () => void;
  onLogout: () => void;
}

export const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  username,
  onAddZone,
  onAddDevice,
  onLogout,
}) => {
  const { t } = useTranslation('dashboard');
  const showDesktopData = isDesktopBrowser();

  return (
    <header className="bg-[var(--header-bg)] shadow-xl">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-4xl font-bold text-[var(--header-text)] high-contrast-text">
              OSI OS Dashboard
            </h1>
            <p className="text-[var(--header-subtext)] text-lg mt-1">{t('welcome', { username })}</p>
          </div>

          <div className="flex max-w-full flex-row flex-nowrap items-center gap-2 overflow-x-auto">
            <HeaderMenu
              label={t('add')}
              className="shrink-0"
              triggerClassName="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white text-sm px-3 py-2 touch-target shadow-lg"
              items={[
                { key: 'zone', label: t('addMenu.zone'), onSelect: onAddZone },
                { key: 'device', label: t('addMenu.device'), onSelect: onAddDevice },
              ]}
            />

            {showDesktopData && (
              <Link
                to="/history"
                className="shrink-0 bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-3 py-2 touch-target rounded-lg transition-colors shadow-lg"
              >
                {t('data')}
              </Link>
            )}

            <span className="hidden sm:block w-px self-stretch bg-[var(--border)]" aria-hidden="true" />

            <div className="shrink-0">
              <LanguageSwitcher />
            </div>

            <HeaderMenu
              label={t('account')}
              className="shrink-0"
              triggerClassName="bg-slate-900 hover:bg-slate-800 text-white text-sm px-3 py-2 touch-target"
              items={[
                { key: 'osi-server', label: t('accountMenu.osiServer'), to: '/account-link' },
                { key: 'logout', label: t('logout'), onSelect: onLogout },
              ]}
            />
          </div>
        </div>
      </div>
    </header>
  );
};
