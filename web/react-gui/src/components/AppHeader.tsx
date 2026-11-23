import React, { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HeaderMenu } from './HeaderMenu';
import { LanguageSwitcher } from './LanguageSwitcher';
import { isDesktopBrowser } from '../utils/isDesktopBrowser';
import { useGatewayModules } from '../hooks/useGatewayModules';
import { useDesktopData } from '../history/useDesktopData';

type TabKey = 'zones' | 'data' | 'journal' | 'network';

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
  /** Adds Users / Access grants to Account when the caller is a scoped admin. */
  showAdmin?: boolean;
}

const HEADER_BUTTON =
  'inline-flex min-h-11 items-center justify-center rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-center text-sm font-bold text-[var(--text)] transition-colors hover:bg-[var(--border)]';

/**
 * Top-level chrome for pages that carry the primary tab bar
 * (Zones / Data / Journal): page title + welcome line, the action row, and the
 * tab navigation. Data uses Analysis on desktop and History on narrow screens
 * and mobile browsers.
 *
 * DashboardHeader and HistoryMobileHeader compose this same navigation.
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
  // Module visibility (2026-09-17): gateway-level settings, so every user of a
  // gateway sees the same tabs. A tab disappearing here does not unregister its
  // route -- /analysis, /history and /journal stay reachable by URL, and a page
  // rendered under a hidden tab still renders.
  //
  // null until the gateway has answered: the gated tabs render nothing until
  // then, rather than appearing and being taken away (or the reverse) once the
  // answer arrives.
  const modules = useGatewayModules();

  const dataTarget = useDesktopData() ? '/analysis' : '/history';
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
    ...(modules?.data
      ? [{ key: 'data' as const, label: t('tabs.data'), to: dataTarget, active: dataActive }]
      : []),
    ...(modules?.journal
      ? [{
        key: 'journal' as const,
        label: t('tabs.journal'),
        to: '/journal',
        active: activeTab === 'journal' || pathname.startsWith('/journal'),
      }]
      : []),
    // Same gate as DashboardHeader's own Network link (2026-09-17 module
    // visibility): a desktop browser with the module switched on for this
    // gateway. Without this tab the Network page was the only page with no
    // "way back" and no "where am I" -- a lone Zones pill next to it.
    ...(isDesktopBrowser() && modules?.network === true
      ? [{
        key: 'network' as const,
        label: t('network', { defaultValue: 'Network' }),
        to: '/network',
        active: activeTab === 'network' || pathname.startsWith('/network'),
      }]
      : []),
  ];

  return (
    <header className="bg-[var(--header-bg)] shadow-xl">
      <div className="max-w-7xl mx-auto px-4 pt-4 sm:pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3 lg:items-center">
          <div className="min-w-0 flex-1 sm:basis-full lg:basis-0">
            <div className="min-w-0">
              <h1 className="text-2xl sm:text-3xl font-bold text-[var(--header-text)] high-contrast-text break-words">
                {title}
              </h1>
              {username && <p className="text-[var(--header-subtext)] text-base mt-1">
                {t('welcome', { username })}
              </p>}
            </div>
          </div>
          <HeaderActions onLogout={onLogout} showAdmin={showAdmin} actions={actions} />
        </div>

        <nav className="mt-4 pb-3" aria-label={t('header.primaryNavigation')}>
          <div className="inline-flex max-w-full flex-wrap gap-1 rounded-lg bg-[var(--secondary-bg)] p-1">
            {tabs.map((tab) => (
              <Link
                key={tab.key}
                to={tab.to}
                aria-current={tab.active ? 'page' : undefined}
                className={`max-w-full break-words rounded-md px-5 py-2 text-[15px] font-semibold transition-colors ${
                  tab.active
                    ? 'bg-[var(--primary)] text-[var(--on-primary)] shadow'
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

function HeaderActions({ onLogout, showAdmin, actions }: Pick<AppHeaderProps, 'onLogout' | 'showAdmin' | 'actions'>) {
  const { t } = useTranslation(['dashboard', 'settings']);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('button, a')?.focus();
    const dismiss = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [open]);

  return <div ref={container} className="relative flex shrink-0 items-center gap-2 max-sm:basis-full max-sm:justify-end sm:ml-auto" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={(event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && open) {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
  }}>
    <div className="sm:order-2">
      <LanguageSwitcher triggerClassName="min-h-11 px-3 py-2 text-sm" />
    </div>
    <button ref={trigger} type="button" className={`${HEADER_BUTTON} sm:hidden gap-2`}
      aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 6h16M4 12h16M4 18h16" />
      </svg>
      {t('header.menu')}
    </button>
    <div ref={panel} id={panelId} className={`${open ? 'flex' : 'hidden'} absolute right-0 top-full z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--header-bg)] p-3 shadow-xl sm:static sm:mt-0 sm:contents sm:w-auto sm:max-w-none sm:flex-row sm:items-center sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none`}>
      <div className="flex flex-col gap-2 sm:order-1 sm:flex-row sm:items-center">
        {actions}
        <Link to="/settings" className={HEADER_BUTTON}>{t('settings:entryPoint')}</Link>
      </div>
      <div className="sm:order-3">
        <HeaderMenu label={t('account')} triggerClassName={HEADER_BUTTON} items={[
          ...(showAdmin ? [
            { key: 'admin-users', label: t('adminMenu.users'), to: '/admin/users' },
            { key: 'admin-grants', label: t('adminMenu.grants'), to: '/admin/grants' },
          ] : []),
          { key: 'osi-server', label: t('accountMenu.osiServer'), to: '/account-link' },
          { key: 'logout', label: t('logout'), onSelect: onLogout },
        ]} />
      </div>
    </div>
  </div>;
}

export { HEADER_BUTTON };
