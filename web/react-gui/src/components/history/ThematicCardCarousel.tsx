import React from 'react';
import { orderHistoryCards } from '../../history/useHistoryCards';
import type { HistoryCardSummary } from '../../history/types';

interface ThematicCardCarouselProps {
  cards: HistoryCardSummary[];
  selectedCardId: string | null;
  onSelectCard: (cardId: string) => void;
}

function cardTypeLabel(card: HistoryCardSummary): string {
  return `${card.cardType.charAt(0).toUpperCase()}${card.cardType.slice(1)} card`;
}

function coverageLabel(card: HistoryCardSummary): string {
  const coveragePct = card.metadata.coveragePct;
  return coveragePct === null || coveragePct === undefined
    ? 'Coverage unknown'
    : `${Math.round(coveragePct)}% coverage`;
}

export const ThematicCardCarousel: React.FC<ThematicCardCarouselProps> = ({
  cards,
  selectedCardId,
  onSelectCard,
}) => {
  const orderedCards = orderHistoryCards(cards);

  if (orderedCards.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--text-tertiary)]">
        No history cards are available for this zone yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pb-2" aria-label="History card carousel">
      <div className="flex snap-x snap-mandatory gap-3">
        {orderedCards.map((card) => {
          const selected = card.cardId === selectedCardId;
          return (
            <button
              key={card.cardId}
              type="button"
              aria-label={`${card.title} card`}
              aria-pressed={selected}
              onClick={() => onSelectCard(card.cardId)}
              className={`min-w-[17rem] snap-start rounded-lg border p-4 text-left transition-colors ${
                selected
                  ? 'border-[var(--primary)] bg-[var(--surface)] shadow-md'
                  : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--secondary-bg)]'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                    {cardTypeLabel(card)}
                  </p>
                  <h3 className="mt-1 text-lg font-bold text-[var(--text)]">{card.title}</h3>
                </div>
                {card.ordering.pinned && (
                  <span className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-xs font-semibold text-[var(--text)]">
                    Pinned
                  </span>
                )}
              </div>
              {card.subtitle && (
                <p className="mt-2 text-sm text-[var(--text-tertiary)]">{card.subtitle}</p>
              )}
              <p className="mt-4 text-xs font-semibold text-[var(--text-tertiary)]">
                {coverageLabel(card)}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
};
