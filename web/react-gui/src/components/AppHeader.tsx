import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HeaderMenu } from './HeaderMenu';
import { isDesktopBrowser } from '../utils/isDesktopBrowser';

type TabKey = 'zones' | 'data' | 'journal';

interface AppHeaderProps {
  /** Page title shown in the header H1. */
  title: string;
  /** Which primary tab is active on this page, if any. */
  activeTab?: TabKey;
  username: string | null;
  onLogout: () => void;
  /**
   * Page-specific primary actions, rendered left of the always-present
   * Settings and Account controls.
   */
  actions?: React.ReactNode;
  /** Shows the Admin menu (Users / Grants) when the caller is a scoped admin. */
  showAdmin?: boolean;
}

const HEADER_BUTTON =
  'rounded-lg bg-[var(--secondary-bg)] px-6 py-3 text-center text-lg font-bold text-[var(--text)] shadow-lg transition-colors hover:bg-[var(--border)]';

/**
 * Top-level chrome for pages that carry the primary tab bar
 * (Zones / Data / Journal): page title + welcome line, the action row, and the
 * tab navigation. The Data tab routes to the desktop analysis workspace or the
 * mobile history view depending on the device — the two are one destination.
 *
 * Styling deliberately mirrors DashboardHeader so the Journal page sits inside
 * the same chrome as the rest of the GUI.
 */
export const AppHeader: React.FC<AppHeaderProps> = ({
  title,
  activeTab,
  username,
  onLogout,
  actions,
  showAdmin = false,
}) => {
  const { t } = useTranslation(['dashboard', 'settings']);
  const { pathname } = useLocation();

  const dataTarget = isDesktopBrowser() ? '/analysis' : '/history';
  const dataActive =
    activeTab === 'data' ||
    pathname.startsWith('/history') ||
    pathname.startsWith('/analysis');

  const tabs: Array<{ key: TabKey; label: string; to: string; active: boolean }> = [
    {
      key: 'zones',
      label: t('tabs.zones'),
      to: '/dashboard',
      active: activeTab === 'zones' || pathname === '/dashboard',
    },
    { key: 'data', label: t('tabs.data'), to: dataTarget, active: dataActive },
    {
      key: 'journal',
      label: t('tabs.journal'),
      to: '/journal',
      active: activeTab === 'journal' || pathname.startsWith('/journal'),
    },
  ];

  return (
    <header className="bg-[var(--header-bg)] shadow-xl">
      <div className="max-w-7xl mx-auto px-4 pt-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-[var(--header-text)] high-contrast-text">
              {title}
            </h1>
            <p className="text-[var(--header-subtext)] text-lg mt-1">
              {t('welcome', { username })}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
            {actions}

            {showAdmin && (
              <HeaderMenu
                label={t('admin')}
                className="w-[calc(50%-4px)] sm:w-auto"
                triggerClassName="bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] text-lg px-6 py-3"
                items={[
                  { key: 'admin-users', label: t('adminMenu.users'), to: '/admin/users' },
                  { key: 'admin-grants', label: t('adminMenu.grants'), to: '/admin/grants' },
                ]}
              />
            )}

            <Link to="/settings" className={`w-[calc(50%-4px)] sm:w-auto ${HEADER_BUTTON}`}>
              {t('settings:entryPoint')}
            </Link>

            <HeaderMenu
              label={t('account')}
              className="w-[calc(50%-4px)] sm:w-auto"
              triggerClassName="bg-slate-900 hover:bg-slate-800 text-white text-lg px-6 py-3"
              items={[
                { key: 'osi-server', label: t('accountMenu.osiServer'), to: '/account-link' },
                { key: 'logout', label: t('logout'), onSelect: onLogout },
              ]}
            />
          </div>
        </div>

        <nav className="mt-4 pb-3" aria-label="Primary">
          <div className="inline-flex gap-1 rounded-lg bg-[var(--secondary-bg)] p-1">
            {tabs.map((tab) => (
              <Link
                key={tab.key}
                to={tab.to}
                aria-current={tab.active ? 'page' : undefined}
                className={`rounded-md px-5 py-2 text-[15px] font-semibold transition-colors ${
                  tab.active
                    ? 'bg-[var(--primary)] text-white shadow'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text)]'
                }`}
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </header>
  );
};

export { HEADER_BUTTON };
