import React from 'react';
import type { IrrigationAction } from '../../../types/farming';
import { ACTION_CONFIG } from './stressConfig';

interface Props {
  action: IrrigationAction;
  reasoning: string;
  /** Optional 7-day stress history dots (oldest → newest) */
  history?: Array<{ date: string; stress: string }>;
}

const DOT_COLOR: Record<string, string> = {
  none:        'bg-green-500',
  mild:        'bg-amber-400',
  moderate:    'bg-orange-500',
  significant: 'bg-red-500',
  severe:      'bg-red-900',
};

export const IrrigationActionBanner: React.FC<Props> = ({ action, reasoning, history }) => {
  const cfg = ACTION_CONFIG[action];
  const recent = history ? [...history].reverse().slice(0, 7).reverse() : [];

  return (
    <div className={`rounded-lg border-2 px-4 py-3 ${cfg.bannerBg} ${cfg.bannerBorder}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xl font-bold leading-none">{cfg.icon}</span>
        <span className={`font-bold text-base ${cfg.bannerText}`}>{cfg.label}</span>
      </div>
      <p className={`text-sm ${cfg.bannerText} opacity-80`}>{reasoning}</p>

      {recent.length > 0 && (
        <div className="flex items-center gap-1.5 mt-2.5">
          <span className="text-xs text-[var(--text-tertiary)] mr-1">7 days:</span>
          {recent.map((r, i) => (
            <span
              key={i}
              className={`w-3 h-3 rounded-full inline-block ${DOT_COLOR[r.stress] ?? 'bg-gray-300'}`}
              title={`${r.date}: ${r.stress}`}
            />
          ))}
        </div>
      )}
    </div>
  );
};
