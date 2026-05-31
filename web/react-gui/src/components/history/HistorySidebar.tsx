import React from 'react';
import { orderHistoryCards } from '../../history/useHistoryCards';
import type { HistoryCardSummary } from '../../history/types';
import type { IrrigationZone } from '../../types/farming';

interface HistorySidebarProps {
  zones: IrrigationZone[];
  selectedZoneId: number | null;
  onSelectZone: (zoneId: number) => void;
  cards: HistoryCardSummary[];
  selectedCardId: string | null;
  onSelectCard: (cardId: string) => void;
}

export const HistorySidebar: React.FC<HistorySidebarProps> = ({
  zones,
  selectedZoneId,
  onSelectZone,
  cards,
  selectedCardId,
  onSelectCard,
}) => {
  const orderedCards = orderHistoryCards(cards);
  const pinnedCards = orderedCards.filter((card) => card.ordering.pinned);
  const availableCards = orderedCards.filter((card) => !card.ordering.pinned);

  return (
    <aside className="h-full border-r border-[var(--border)] bg-[var(--surface)] p-4">
      <section>
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
          Zones
        </h2>
        <div className="mt-3 space-y-2">
          {zones.map((zone) => (
            <button
              key={zone.id}
              type="button"
              aria-pressed={zone.id === selectedZoneId}
              onClick={() => onSelectZone(zone.id)}
              className={`w-full rounded-md border px-3 py-2 text-left text-sm font-semibold transition-colors ${
                zone.id === selectedZoneId
                  ? 'border-[var(--primary)] bg-[var(--secondary-bg)] text-[var(--text)]'
                  : 'border-transparent text-[var(--text-tertiary)] hover:border-[var(--border)] hover:text-[var(--text)]'
              }`}
            >
              {zone.name}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
          Pinned cards
        </h2>
        <CardList cards={pinnedCards} selectedCardId={selectedCardId} onSelectCard={onSelectCard} />
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
          Available cards
        </h2>
        <CardList cards={availableCards} selectedCardId={selectedCardId} onSelectCard={onSelectCard} />
      </section>

      <section className="mt-6 rounded-lg border border-dashed border-[var(--border)] p-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
          Saved workspaces
        </h2>
        <p className="mt-2 text-xs text-[var(--text-tertiary)]">Workspace saving is not enabled on this slice.</p>
      </section>
    </aside>
  );
};

interface CardListProps {
  cards: HistoryCardSummary[];
  selectedCardId: string | null;
  onSelectCard: (cardId: string) => void;
}

const CardList: React.FC<CardListProps> = ({ cards, selectedCardId, onSelectCard }) => {
  if (cards.length === 0) {
    return <p className="mt-3 text-xs text-[var(--text-tertiary)]">None</p>;
  }

  return (
    <div className="mt-3 space-y-2">
      {cards.map((card) => (
        <button
          key={card.cardId}
          type="button"
          aria-pressed={card.cardId === selectedCardId}
          onClick={() => onSelectCard(card.cardId)}
          className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
            card.cardId === selectedCardId
              ? 'border-[var(--primary)] bg-[var(--secondary-bg)]'
              : 'border-[var(--border)] hover:bg-[var(--secondary-bg)]'
          }`}
        >
          <span className="block text-sm font-semibold text-[var(--text)]">{card.title}</span>
          {card.subtitle && (
            <span className="mt-1 block text-xs text-[var(--text-tertiary)]">{card.subtitle}</span>
          )}
        </button>
      ))}
    </div>
  );
};
