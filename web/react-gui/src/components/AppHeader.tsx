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
  /** Accepted for call-site compatibility; the header no longer shows a
      greeting (product decision 2026-07-14). */
  username?: string | null;
  onLogout: () => void;
  /**
   * Page-specific primary actions, rendered left of the always-present
   * Settings and Account controls. The Zones page passes its Add menu here;
   * Data pages pass their view controls. Each child should carry
   * `btn-liquid` for material consistency.
   */
  actions?: React.ReactNode;
  showSettings?: boolean;
  showAdmin?: boolean;
}

/* Phones carry up to three of these next to the tab pill, so they run compact
   below `sm` and reach their full size once there is room. py-2.5 + text-base
   still measures 44px, the touch minimum. */
const LIQUID_SIZING = 'px-3 py-2.5 text-base sm:px-6 sm:py-3 sm:text-lg';

const LIQUID_BUTTON =
  `btn-liquid rounded-lg text-center font-bold text-[var(--text)] ${LIQUID_SIZING}`;

/** Trigger for the header's dropdown menus (Account here, Add on Zones). */
const LIQUID_MENU_TRIGGER = `btn-liquid text-[var(--text)] font-bold ${LIQUID_SIZING}`;

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
  onLogout,
  actions,
  showSettings = true,
  showAdmin = false,
}) => {
  const { t, i18n } = useTranslation(['dashboard', 'settings']);
  const { balkenHorizontal } = resolveAgroscopeAssets(i18n?.language ?? 'en');
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
        {/* Full-bleed red block on the left, wordmark pinned to the content
            column's left edge at every viewport width. See .balken-crown in
            index.css for the width-independent alignment. */}
        <img src={balkenHorizontal} alt="Agroscope Balken" className="balken-crown" />
      </div>
      <header className="glass-chrome sticky top-0 z-30 border-b border-[var(--border)]">
        <div className="max-w-[1600px] mx-auto px-4 py-3">
          <h1 className="sr-only">{title}</h1>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            {/* Primary navigation on its own floating glass pill. The Agroscope
                red returns once here: the active-tab lozenge's specular ring.
                Red stays out of buttons — the app reserves red for danger. */}
            <nav aria-label="Primary">
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

            {/* Wraps for the same reason the parent row does: on the Zones page
                this row also carries the Add menu, which overflows a phone
                narrower than ~389px if it is held on one line. */}
            <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
              {actions}

              {/* Icon-only on phones: the translated label is the widest thing
                  in this row ("Einstellungen"), and spelling it out pushes the
                  Account menu onto a third line in every non-English locale.
                  The accessible name stays the full label at every width. */}
              {showSettings && (
                <Link
                  to="/settings"
                  aria-label={t('settings:entryPoint')}
                  className={`${LIQUID_BUTTON} inline-flex items-center justify-center`}
                >
                  <span aria-hidden="true" className="sm:hidden">⚙</span>
                  <span className="hidden sm:inline">{t('settings:entryPoint')}</span>
                </Link>
              )}

              <HeaderMenu
                label={t('account')}
                triggerClassName={LIQUID_MENU_TRIGGER}
                items={[
                  ...(showAdmin ? [
                    { key: 'admin-users', label: 'Manage users', to: '/admin/users' },
                    { key: 'admin-grants', label: 'Access grants', to: '/admin/grants' },
                  ] : []),
                  { key: 'osi-server', label: t('accountMenu.osiServer'), to: '/account-link' },
                  { key: 'logout', label: t('logout'), onSelect: onLogout },
                ]}
              />
            </div>
          </div>
        </div>
      </header>
    </div>
  );
};

export { LIQUID_BUTTON, LIQUID_MENU_TRIGGER };
