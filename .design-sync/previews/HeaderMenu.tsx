import React from 'react';
import { HeaderMenu } from 'open-smart-irrigation';

// Trigger styles copied from the two real call sites in DashboardHeader.
const PRIMARY_TRIGGER = 'bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white text-lg px-6 py-3';
const ACCOUNT_TRIGGER = 'bg-slate-900 hover:bg-slate-800 text-white text-lg px-6 py-3';

const noop = () => {};

// The dropdown is internal state — open it with a real click on the trigger.
function AutoOpen({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const btn = ref.current?.querySelector('button[aria-haspopup="menu"]') as HTMLElement | null;
    btn?.click();
  }, []);
  return <div ref={ref} style={{ display: 'contents' }}>{children}</div>;
}

function Row({
  children,
  minHeight,
  justify = 'flex-start',
}: {
  children: React.ReactNode;
  minHeight?: number;
  justify?: 'flex-start' | 'flex-end';
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: justify,
        // flex default (stretch) would inflate the menu's positioning parent
        // and detach the dropdown from its trigger
        alignItems: 'flex-start',
        maxWidth: 420,
        minHeight,
        padding: 4,
      }}
    >
      {children}
    </div>
  );
}

/** Resting primary trigger, as the header's "Add" button. */
export function PrimaryClosed() {
  return (
    <Row>
      <HeaderMenu
        label="Add"
        triggerClassName={PRIMARY_TRIGGER}
        align="left"
        items={[
          { key: 'zone', label: 'Add Zone', onSelect: noop },
          { key: 'device', label: 'Add Device', onSelect: noop },
        ]}
      />
    </Row>
  );
}

/** Add menu clicked open, left-aligned dropdown (first item holds focus). */
export function PrimaryOpen() {
  return (
    <Row minHeight={170}>
      <AutoOpen>
        <HeaderMenu
          label="Add"
          triggerClassName={PRIMARY_TRIGGER}
          align="left"
          items={[
            { key: 'zone', label: 'Add Zone', onSelect: noop },
            { key: 'device', label: 'Add Device', onSelect: noop },
          ]}
        />
      </AutoOpen>
    </Row>
  );
}

/** Account menu variant: dark trigger, right-aligned menu mixing a link and an action. */
export function AccountOpen() {
  return (
    <Row minHeight={170} justify="flex-end">
      <AutoOpen>
        <HeaderMenu
          label="Account"
          triggerClassName={ACCOUNT_TRIGGER}
          items={[
            { key: 'osi-server', label: 'OSI Server', to: '/account-link' },
            { key: 'logout', label: 'Logout', onSelect: noop },
          ]}
        />
      </AutoOpen>
    </Row>
  );
}
