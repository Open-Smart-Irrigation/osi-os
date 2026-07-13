import React from 'react';
import { LanguageSwitcher } from 'open-smart-irrigation';

// In the app the switcher sits at the right edge of page chrome (login page,
// settings) — mirror that so the right-aligned dropdown stays in frame.
function ChromeRow({ children, minHeight }: { children: React.ReactNode; minHeight?: number }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'flex-start',
        maxWidth: 420,
        minHeight,
        padding: 8,
      }}
    >
      {children}
    </div>
  );
}

// The menu is internal state — open it with a real click on the trigger.
function AutoOpen({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const btn = ref.current?.querySelector('button[title="Change language"]') as HTMLElement | null;
    btn?.click();
  }, []);
  return <div ref={ref} style={{ display: 'contents' }}>{children}</div>;
}

/** Resting trigger: current language with the open affordance. */
export function Closed() {
  return (
    <ChromeRow>
      <LanguageSwitcher />
    </ChromeRow>
  );
}

/** Clicked open: all seven languages, current one highlighted. */
export function OpenMenu() {
  return (
    <ChromeRow minHeight={330}>
      <AutoOpen>
        <LanguageSwitcher />
      </AutoOpen>
    </ChromeRow>
  );
}
