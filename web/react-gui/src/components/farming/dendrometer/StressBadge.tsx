import React from 'react';
import type { StressLevel } from '../../../types/farming';
import { STRESS_CONFIG } from './stressConfig';

interface Props {
  level: StressLevel;
  size?: 'sm' | 'md';
}

export const StressBadge: React.FC<Props> = ({ level, size = 'md' }) => {
  const cfg = STRESS_CONFIG[level];
  const dots = '●'.repeat(cfg.dots) + '○'.repeat(5 - cfg.dots);
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';
  const padding  = size === 'sm' ? 'px-2 py-0.5' : 'px-2.5 py-1';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold tracking-wide ${textSize} ${padding} ${cfg.badgeBg} ${cfg.badgeText}`}
    >
      <span className="font-mono tracking-tighter text-xs leading-none" aria-hidden>
        {dots}
      </span>
      {cfg.label}
    </span>
  );
};
