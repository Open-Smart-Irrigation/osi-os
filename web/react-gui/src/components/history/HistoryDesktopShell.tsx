import React from 'react';
import { HistoryCardFrame } from './HistoryCardFrame';
import { HistorySidebar } from './HistorySidebar';
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
            Toolbar
          </p>
          <p className="mt-1 text-sm text-[var(--text-tertiary)]">
            Date range, aggregation, export, and sync controls land here in the visualization slice.
          </p>
        </div>
        <HistoryCardFrame card={selectedCard} />
      </main>

      <aside className="border-l border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
          Inspector
        </h2>
        <p className="mt-3 text-sm text-[var(--text-tertiary)]">
          Select a timestamp or calendar cell to see interpretation, events, data quality, and advanced metadata.
        </p>
      </aside>
    </div>
  );
};
