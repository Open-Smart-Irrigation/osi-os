import React from 'react';
import { AppHeader } from 'open-smart-irrigation';

const noop = () => {};

/**
 * Shared AgroLink top-level chrome: Agroscope Balken crown (scroll-away), the
 * sticky liquid-glass header, the floating-glass Zones/Data/Journal pill (red
 * active lozenge), the welcome line, and the Settings/Account action row.
 * Every top-level page mounts this; `activeTab` marks the current page and
 * `actions` injects page-specific buttons left of Settings/Account.
 */
export function ZonesActive() {
  return (
    <AppHeader
      title="Zones"
      activeTab="zones"
      username="demo"
      onLogout={noop}
      actions={
        <span className="btn-liquid rounded-lg px-6 py-3 text-lg font-bold text-[var(--text)]">
          Add
        </span>
      }
    />
  );
}

export function DataActive() {
  return <AppHeader title="Data" activeTab="data" username="demo" onLogout={noop} />;
}

export function JournalActive() {
  return <AppHeader title="Journal" activeTab="journal" username="demo" onLogout={noop} />;
}
