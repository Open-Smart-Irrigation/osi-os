import React from 'react';

import { buildDeviceFooterMeta } from './deviceCardBattery';

interface DeviceCardFooterProps {
  lastSeenLabel: string;
  batteryPercent?: unknown;
  batteryVoltage?: unknown;
  leftContent?: React.ReactNode;
  actions?: React.ReactNode;
}

export const DeviceCardFooter: React.FC<DeviceCardFooterProps> = ({
  lastSeenLabel,
  batteryPercent,
  batteryVoltage,
  leftContent,
  actions,
}) => (
  <div className="mt-3 border-t border-[var(--border)] pt-3">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1 text-xs text-[var(--text-tertiary)]">
        {leftContent ?? null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions ?? null}
        <p className="text-xs text-[var(--text-tertiary)]">
          {buildDeviceFooterMeta({ batPct: batteryPercent, batV: batteryVoltage, lastSeenLabel })}
        </p>
      </div>
    </div>
  </div>
);
