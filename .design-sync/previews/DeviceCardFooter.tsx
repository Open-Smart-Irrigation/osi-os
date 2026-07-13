import React from 'react';
import { DeviceCardFooter } from 'open-smart-irrigation';

// The footer needs a bordered parent to read as a card footer — every device
// card in the app renders it at the bottom of a white rounded card.
function CardFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '12px 16px',
        maxWidth: 380,
      }}
    >
      <div style={{ color: 'var(--text-secondary)', fontSize: 14, paddingBottom: 8 }}>
        Soil sensor — North Field
      </div>
      {children}
    </div>
  );
}

export function WithBatteryPercent() {
  return (
    <CardFrame>
      <DeviceCardFooter lastSeenLabel="Last seen 5 min ago" batteryPercent={87} />
    </CardFrame>
  );
}

export function LowBattery() {
  return (
    <CardFrame>
      <DeviceCardFooter lastSeenLabel="Last seen 2 h ago" batteryPercent={12} batteryVoltage={3.1} />
    </CardFrame>
  );
}

export function WithoutBattery() {
  return (
    <CardFrame>
      <DeviceCardFooter lastSeenLabel="Last seen just now" />
    </CardFrame>
  );
}

export function WithActions() {
  return (
    <CardFrame>
      <DeviceCardFooter
        lastSeenLabel="Last seen 12 min ago"
        batteryPercent={64}
        actions={
          <button
            type="button"
            style={{
              background: 'var(--secondary-bg)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 12,
            }}
          >
            Settings
          </button>
        }
      />
    </CardFrame>
  );
}
