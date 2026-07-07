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
  const { t } = useTranslation(['dashboard', 'support']);
  const showDesktopData = isDesktopBrowser();

  return (
    <header className="bg-[var(--header-bg)] shadow-xl">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-4xl font-bold text-[var(--header-text)] high-contrast-text">
              {t('title')}
            </h1>
            <p className="text-[var(--header-subtext)] text-lg mt-1">{t('welcome', { username })}</p>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
            <HeaderMenu
              label={t('add')}
              className="w-[calc(50%-4px)] sm:w-auto"
              triggerClassName="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white text-lg px-6 py-3"
              align="left"
              items={[
                { key: 'zone', label: t('addMenu.zone'), onSelect: onAddZone },
                { key: 'device', label: t('addMenu.device'), onSelect: onAddDevice },
              ]}
            />

            {showDesktopData && (
              <Link
                to="/analysis"
                className="w-[calc(50%-4px)] sm:w-auto bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-lg px-6 py-3 rounded-lg transition-colors shadow-lg text-center"
              >
                {t('data')}
              </Link>
            )}

            <span className="hidden sm:block w-px self-stretch bg-[var(--border)]" aria-hidden="true" />

            <div className="w-[calc(50%-4px)] sm:w-auto">
              <LanguageSwitcher triggerClassName="w-full justify-center px-6 py-3 text-lg sm:w-auto" />
            </div>

            <HeaderMenu
              label={t('account')}
              className="w-[calc(50%-4px)] sm:w-auto"
              triggerClassName="bg-slate-900 hover:bg-slate-800 text-white text-lg px-6 py-3"
              items={[
                { key: 'osi-server', label: t('accountMenu.osiServer'), to: '/account-link' },
                { key: 'support-requests', label: t('support:navLabel'), to: '/support-requests' },
                { key: 'logout', label: t('logout'), onSelect: onLogout },
              ]}
            />
          </div>
        </div>
      </div>
    </header>
  );
};
