import React from 'react';
import { DashboardHeader } from 'open-smart-irrigation';

const noop = () => {};

/**
 * The AgroLink branding showcase: Agroscope red Balken strip across the top,
 * blue header bar, title + welcome line, and the Add / Data / Settings /
 * Account actions.
 */
export function Canonical() {
  return (
    <DashboardHeader username="demo" onAddZone={noop} onAddDevice={noop} onLogout={noop} />
  );
}

// No open-menu story on purpose: the branding commit's `overflow-hidden` on
// <header> clips the header's own dropdown menus at its bottom edge (a real
// regression in the branded app, not a preview artifact). Add an open-menu
// story once the source moves `overflow-hidden` onto a Balken-image wrapper.
// See NOTES.md "Product bug found during sync".
