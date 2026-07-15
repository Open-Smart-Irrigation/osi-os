import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HeaderMenu } from './HeaderMenu';
import { resolveAgroscopeAssets } from '../branding/agrolink';
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
   * Settings and Account controls. The Zones page passes its Add menu here;
   * Data pages pass their view controls. Each child should carry
   * `btn-liquid` for material consistency.
   */
  actions?: React.ReactNode;
}

const LIQUID_BUTTON =
  'btn-liquid rounded-lg px-6 py-3 text-center text-lg font-bold text-[var(--text)]';

/**
 * Shared top-level chrome for AgroLink: Agroscope Balken crown (scroll-away),
 * the sticky liquid-glass header, page title + welcome, the floating-glass
 * primary tab bar (Zones · Data · Journal), and the action row. The Data tab
 * routes to the desktop analysis workspace or the mobile history view
 * depending on the device (the two are one destination — see
 * docs/design/agrolink-design-alignment.md).
 */
export const AppHeader: React.FC<AppHeaderProps> = ({
  title,
  activeTab,
  username,
  onLogout,
  actions,
}) => {
  const { t } = useTranslation(['dashboard', 'settings']);
  const { i18n } = useTranslation();
  const { balkenHorizontal } = resolveAgroscopeAssets(i18n.language);
  const { pathname } = useLocation();

  const dataTarget = isDesktopBrowser() ? '/analysis' : '/history';
  const dataActive =
    activeTab === 'data' ||
    pathname.startsWith('/history') ||
    pathname.startsWith('/analysis');

  const tabs: Array<{ key: TabKey; label: string; to: string; active: boolean }> = [
    { key: 'zones', label: t('tabs.zones'), to: '/dashboard', active: activeTab === 'zones' || pathname === '/dashboard' },
    { key: 'data', label: t('tabs.data'), to: dataTarget, active: dataActive },
    { key: 'journal', label: t('tabs.journal'), to: '/journal', active: activeTab === 'journal' || pathname.startsWith('/journal') },
  ];

  return (
    <div className="font-brand">
      {/* Balken crown: always on white in both themes — the asset's gradient
          tail ends in pure #FFFFFF and is designed to dissolve into a white
          page. It sits in document flow and scrolls away; only the header
          below sticks. */}
      <div className="overflow-hidden bg-white">
        <img
          src={balkenHorizontal}
          alt="Agroscope Balken"
          className="block h-8 w-full object-cover object-left"
        />
      </div>
      <header className="glass-chrome sticky top-0 z-30 border-b border-[var(--border)]">
        <div className="max-w-7xl mx-auto px-4 pt-5">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold text-[var(--header-text)]">{title}</h1>
              <p className="text-[var(--header-subtext)] text-lg mt-1">
                {t('welcome', { username })}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
              {actions}

              <Link to="/settings" className={`w-[calc(50%-4px)] sm:w-auto ${LIQUID_BUTTON}`}>
                {t('settings:entryPoint')}
              </Link>

              <HeaderMenu
                label={t('account')}
                className="w-[calc(50%-4px)] sm:w-auto"
                triggerClassName="btn-liquid text-[var(--text)] text-lg px-6 py-3"
                items={[
                  { key: 'osi-server', label: t('accountMenu.osiServer'), to: '/account-link' },
                  { key: 'logout', label: t('logout'), onSelect: onLogout },
                ]}
              />
            </div>
          </div>

          {/* Primary navigation on its own floating glass pill. The Agroscope
              red returns once here: the active-tab lozenge's specular ring.
              Red stays out of buttons — the app reserves red for danger. */}
          <nav className="mt-4 pb-3" aria-label="Primary">
            <div className="glass-tabs inline-flex gap-1 p-1">
              {tabs.map((tab) => (
                <Link
                  key={tab.key}
                  to={tab.to}
                  aria-current={tab.active ? 'page' : undefined}
                  className={`glass-tab px-5 py-2 text-[15px] font-semibold ${
                    tab.active
                      ? 'text-[var(--header-text)]'
                      : 'text-[var(--text-tertiary)] hover:text-[var(--header-text)]'
                  }`}
                >
                  {tab.label}
                </Link>
              ))}
            </div>
          </nav>
        </div>
      </header>
    </div>
  );
};

export { LIQUID_BUTTON };
