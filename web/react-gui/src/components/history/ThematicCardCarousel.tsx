import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatHistorySourceLabel } from '../../history/sourceLabels';
import { orderHistoryCards } from '../../history/useHistoryCards';
import type { HistoryCardSummary, HistoryCardType } from '../../history/types';

interface ThematicCardCarouselProps {
  cards: HistoryCardSummary[];
  selectedCardId: string | null;
  onSelectCard: (cardId: string) => void;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function cardTypeLabel(t: HistoryTranslate, cardType: HistoryCardType): string {
  return t('history.carousel.cardTypeLabel', {
    cardType: t(`history.cardType.${cardType}`),
  });
}

function coverageLabel(t: HistoryTranslate, card: HistoryCardSummary): string {
  const coveragePct = card.metadata.coveragePct;
  return coveragePct === null || coveragePct === undefined
    ? t('history.metadata.coverageUnknown')
    : t('history.metadata.coverageKnown', { coverage: Math.round(coveragePct) });
}

export const ThematicCardCarousel: React.FC<ThematicCardCarouselProps> = ({
  cards,
  selectedCardId,
  onSelectCard,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const orderedCards = orderHistoryCards(cards);

  if (orderedCards.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--text-tertiary)]">
        {t('history.carousel.empty')}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pb-2" aria-label={t('history.carousel.ariaLabel')}>
      <div className="flex snap-x snap-mandatory gap-3">
        {orderedCards.map((card) => {
          const selected = card.cardId === selectedCardId;
          const sourceLabel = formatHistorySourceLabel(t, card);
          return (
            <button
              key={card.cardId}
              type="button"
              aria-label={t('history.carousel.cardAriaLabel', { title: card.title })}
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
                    {cardTypeLabel(t, card.cardType)}
                  </p>
                  <h3 className="mt-1 text-lg font-bold text-[var(--text)]">{card.title}</h3>
                </div>
                {card.ordering.pinned && (
                  <span className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-xs font-semibold text-[var(--text)]">
                    {t('history.carousel.pinned')}
                  </span>
                )}
              </div>
              {card.subtitle && (
                <p className="mt-2 text-sm text-[var(--text-tertiary)]">{card.subtitle}</p>
              )}
              {sourceLabel && (
                <p className="mt-2 text-sm font-medium text-[var(--text)]">{sourceLabel}</p>
              )}
              <p className="mt-4 text-xs font-semibold text-[var(--text-tertiary)]">
                {coverageLabel(t, card)}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
};
