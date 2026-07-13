import React from 'react';
import { SystemPanel } from 'open-smart-irrigation';

// Gateway system status panel. Takes no props — it fetches /api/system/stats
// on mount, which the preview harness answers with a healthy Pi 5 (51 °C,
// 29 % memory, load 0.42/4 cores, PWM fan at 96/255).

// The reboot confirmation is internal state behind a real click — drive the
// "⟳ Reboot Gateway" button after mount (same idea as the AutoExpand pattern),
// retrying briefly while the panel finishes its initial stats fetch.
function AutoConfirmReboot({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const buttons = ref.current?.querySelectorAll('button') ?? [];
      for (const btn of Array.from(buttons)) {
        if (btn.textContent?.includes('Reboot Gateway')) {
          (btn as HTMLButtonElement).click();
          clearInterval(timer);
          return;
        }
      }
      if (tries > 20) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, []);
  return <div ref={ref}>{children}</div>;
}

export function HealthyGateway() {
  return (
    <div style={{ maxWidth: 900 }}>
      <SystemPanel />
    </div>
  );
}

export function RebootConfirm() {
  return (
    <div style={{ maxWidth: 900 }}>
      <AutoConfirmReboot>
        <SystemPanel />
      </AutoConfirmReboot>
    </div>
  );
}
