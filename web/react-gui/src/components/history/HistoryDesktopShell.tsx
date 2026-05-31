import React from 'react';
import { useTranslation } from 'react-i18next';
import { HistoryCardFrame } from './HistoryCardFrame';
import { HistorySidebar } from './HistorySidebar';
import { maxPanelsByPlatform } from '../../history/platformLimits';
import type { HistoryCardSummary } from '../../history/types';
import type { IrrigationZone } from '../../types/farming';

interface HistoryDesktopShellProps {
  zones: IrrigationZone[];
  selectedZoneId: number | null;
  onSelectZone: (zoneId: number) => void;
  cards: HistoryCardSummary[];
  selectedCard: HistoryCardSummary | null;
  onSelectCard: (cardId: string) => void;
}

export const HistoryDesktopShell: React.FC<HistoryDesktopShellProps> = ({
  zones,
  selectedZoneId,
  onSelectZone,
  cards,
  selectedCard,
  onSelectCard,
}) => {
  const { t } = useTranslation('history');

  return (
    <div className="hidden min-h-[42rem] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)] lg:grid lg:grid-cols-[18rem_minmax(0,1fr)_18rem]">
      <HistorySidebar
        zones={zones}
        selectedZoneId={selectedZoneId}
        onSelectZone={onSelectZone}
        cards={cards}
        selectedCardId={selectedCard?.cardId ?? null}
        onSelectCard={onSelectCard}
      />

      <main className="min-w-0 p-4">
        <div className="mb-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
            {t('history.desktop.toolbarTitle')}
          </p>
          <p className="mt-1 text-sm text-[var(--text-tertiary)]">
            {t('history.desktop.toolbarPlaceholder')}
          </p>
          <p className="mt-2 text-xs font-semibold text-[var(--text-tertiary)]">
            {t('history.desktop.maxPanels', { count: maxPanelsByPlatform.edge })}
          </p>
        </div>
        <HistoryCardFrame
          card={selectedCard}
          scope={selectedZoneId === null ? null : { type: 'zone', zoneId: selectedZoneId }}
        />
      </main>

      <aside className="border-l border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('history.desktop.inspectorTitle')}
        </h2>
        <p className="mt-3 text-sm text-[var(--text-tertiary)]">
          {t('history.desktop.inspectorPlaceholder')}
        </p>
      </aside>
    </div>
  );
};
