import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface HistorySourcePopoverSource {
  key: string;
  name: string;
}

interface HistorySourcePopoverProps {
  sources: readonly HistorySourcePopoverSource[];
  enabledKeys: readonly string[];
  onChange: (enabledKeys: string[]) => void;
  compact?: boolean;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

export const HistorySourcePopover: React.FC<HistorySourcePopoverProps> = ({
  sources,
  enabledKeys,
  onChange,
  compact = false,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const [open, setOpen] = useState(false);

  if (sources.length <= 1) return null;

  const enabled = new Set(enabledKeys);
  const toggleSource = (key: string) => {
    const next = enabled.has(key)
      ? sources.map((source) => source.key).filter((sourceKey) => sourceKey !== key && enabled.has(sourceKey))
      : sources.map((source) => source.key).filter((sourceKey) => sourceKey === key || enabled.has(sourceKey));
    if (next.length === 0) return;
    onChange(next);
  };

  return (
    <div className="relative">
      <button
        type="button"
        className={`rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] text-sm font-bold text-[var(--text)] ${compact ? 'px-2 py-1' : 'px-3 py-2'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('history.sources.button')}
        onClick={() => setOpen((value) => !value)}
      >
        ⊟
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('history.sources.menuLabel')}
          className="absolute right-0 top-full z-20 mt-2 min-w-56 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg"
        >
          {sources.map((source) => (
            <label
              key={source.key}
              className="flex items-center gap-2 rounded px-2 py-2 text-sm font-semibold text-[var(--text)] hover:bg-[var(--secondary-bg)]"
            >
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={enabled.has(source.key)}
                onChange={() => toggleSource(source.key)}
              />
              <span>{source.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};
