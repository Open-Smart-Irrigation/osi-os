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

// Open the "Add" menu with a real click on its trigger. (The branding
// commit's overflow-hidden regression that used to clip this dropdown was
// fixed by moving the crop onto the Balken image wrapper.)
function AutoOpenFirstMenu({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const btn = ref.current?.querySelector('button[aria-haspopup="menu"]') as HTMLElement | null;
    btn?.click();
  }, []);
  return <div ref={ref}>{children}</div>;
}

export function AddMenuOpen() {
  return (
    <AutoOpenFirstMenu>
      <div style={{ paddingBottom: 180 }}>
        <DashboardHeader username="demo" onAddZone={noop} onAddDevice={noop} onLogout={noop} />
      </div>
    </AutoOpenFirstMenu>
  );
}
