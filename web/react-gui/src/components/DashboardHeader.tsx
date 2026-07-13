import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HeaderMenu } from './HeaderMenu';
import { resolveAgroscopeAssets } from '../branding/agrolink';
import { isDesktopBrowser } from '../utils/isDesktopBrowser';

interface DashboardHeaderProps {
  username: string | null;
  onAddZone: () => void;
  onAddDevice: () => void;
  onLogout: () => void;
}

const GHOST_BUTTON =
  'rounded-lg border border-[var(--border)] bg-[var(--card)] px-6 py-3 text-center text-lg font-bold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)]';

export const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  username,
  onAddZone,
  onAddDevice,
  onLogout,
}) => {
  const { t, i18n } = useTranslation(['dashboard', 'settings']);
  const { balkenHorizontal } = resolveAgroscopeAssets(i18n.language);
  const { pathname } = useLocation();
  const showDesktopData = isDesktopBrowser();

  const tabs = [
    { key: 'zones', label: t('tabs.zones'), to: '/dashboard' },
    { key: 'history', label: t('tabs.history'), to: '/history' },
    { key: 'analysis', label: t('tabs.analysis'), to: '/analysis' },
  ];

  return (
    <div className="font-brand">
      {/* Balken crown: always on white, in both themes — the asset's gradient
          tail ends in pure #FFFFFF and is designed to dissolve into a white
          page. It sits in document flow and scrolls away; only the header
          below sticks. overflow-hidden must stay on this wrapper, never on
          the <header> (its dropdown menus would be clipped at the edge). */}
      <div className="overflow-hidden bg-white">
        <img
          src={balkenHorizontal}
          alt="Agroscope Balken"
          className="block h-8 w-full object-cover object-left"
        />
      </div>
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--header-bg)]">
        <div className="max-w-7xl mx-auto px-4 pt-5">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold text-[var(--header-text)]">
                {t('title')}
              </h1>
              <p className="text-[var(--header-subtext)] text-lg mt-1">{t('welcome', { username })}</p>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
              <HeaderMenu
                label={t('add')}
                className="w-[calc(50%-4px)] sm:w-auto"
                triggerClassName="bg-[var(--text)] text-[var(--card)] hover:opacity-85 text-lg px-6 py-3"
                align="left"
                items={[
                  { key: 'zone', label: t('addMenu.zone'), onSelect: onAddZone },
                  { key: 'device', label: t('addMenu.device'), onSelect: onAddDevice },
                ]}
              />

              {showDesktopData && (
                <Link to="/analysis" className={`w-[calc(50%-4px)] sm:w-auto ${GHOST_BUTTON}`}>
                  {t('data')}
                </Link>
              )}

              <Link to="/journal" className={`w-[calc(50%-4px)] sm:w-auto ${GHOST_BUTTON}`}>
                {t('journal')}
              </Link>

              <Link to="/settings" className={`w-[calc(50%-4px)] sm:w-auto ${GHOST_BUTTON}`}>
                {t('settings:entryPoint')}
              </Link>

              <HeaderMenu
                label={t('account')}
                className="w-[calc(50%-4px)] sm:w-auto"
                triggerClassName="border border-[var(--border)] bg-[var(--card)] text-[var(--text)] hover:bg-[var(--secondary-bg)] text-lg px-6 py-3"
                items={[
                  { key: 'osi-server', label: t('accountMenu.osiServer'), to: '/account-link' },
                  { key: 'logout', label: t('logout'), onSelect: onLogout },
                ]}
              />
            </div>
          </div>

          {/* Primary navigation. The Agroscope red returns exactly once below
              the Balken: the active-tab underline. Red stays out of buttons —
              the app reserves red for danger. */}
          <nav className="mt-4 flex gap-6" aria-label="Primary">
            {tabs.map((tab) => {
              const active = pathname === tab.to || pathname.startsWith(`${tab.to}/`);
              return (
                <Link
                  key={tab.key}
                  to={tab.to}
                  aria-current={active ? 'page' : undefined}
                  className={`border-b-[3px] pb-2.5 pt-1 text-[15px] font-semibold transition-colors ${
                    active
                      ? 'border-[var(--brand-red)] text-[var(--header-text)]'
                      : 'border-transparent text-[var(--text-tertiary)] hover:text-[var(--header-text)]'
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
    </div>
  );
};
