import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { DataExportSection } from '../../farming/DataExportSection';
import type { RangeValue } from '../../farming/rangeCalendarModel';

interface HistoryExportSheetProps {
  isOpen: boolean;
  onClose: () => void;
  zoneId: number;
  todayIso: string;
  defaultChannels: string[];
  initialRange: RangeValue;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

export const HistoryExportSheet: React.FC<HistoryExportSheetProps> = ({
  isOpen,
  onClose,
  zoneId,
  todayIso,
  defaultChannels,
  initialRange,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    closeButtonRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="fixed inset-0 z-20 cursor-default bg-black/25"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-export-title"
        className="fixed inset-x-3 bottom-3 z-30 mx-auto max-h-[78vh] max-w-2xl overflow-y-auto rounded-t-lg border border-[var(--border)] bg-[var(--surface)] p-4 shadow-2xl sm:inset-x-4"
      >
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-[var(--border)]" aria-hidden="true" />
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id="history-export-title" className="text-lg font-bold text-[var(--text)]">
            {t('history.export.title')}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-3 py-2 text-sm font-bold text-[var(--text)]"
            onClick={onClose}
          >
            {t('history.inspector.close')}
          </button>
        </div>
        <DataExportSection
          zoneId={zoneId}
          todayIso={todayIso}
          defaultChannels={defaultChannels}
          initialRange={initialRange}
        />
      </section>
    </>
  );
};
