import React, { useState } from 'react';
import { HistoryCardVisualization } from '../HistoryCardVisualization';
import { desktopRailCardLabel } from '../../../history/desktopHistory';
import { useHistoryCardData } from '../../../history/useHistoryCardData';
import type { HistoryCardDataScope } from '../../../history/useHistoryCardData';
import type { HistoryViewport } from '../../../history/historyViewport';
import type { HistoryCardSummary, HistoryRangeSelection, HistoryViewMode } from '../../../history/types';

const MAX_COMPARE_PANELS = 4;

// ---------- ComparePanel ----------
// One mounted child component per card so each has its own useHistoryCardData call.
// Mounting/unmounting whole children as the selection changes is hooks-safe.

interface ComparePanelProps {
  card: HistoryCardSummary;
  scope: HistoryCardDataScope;
  viewport: HistoryViewport;
  rangeRequest: HistoryRangeSelection;
}

const ComparePanel: React.FC<ComparePanelProps> = ({ card, scope, viewport, rangeRequest }) => {
  const defaultView = (card.defaultView ?? 'line-chart') as HistoryViewMode;

  const cardData = useHistoryCardData({
    scope,
    cardId: card.cardId,
    view: defaultView,
    range: rangeRequest,
    aggregation: 'raw',
    overlays: [],
    enabled: Boolean(card.availability.available),
  });

  return (
    <div
      data-testid="compare-panel"
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)]"
    >
      {/* Panel header */}
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
        <span className="text-sm font-medium text-[var(--text)]">{desktopRailCardLabel(card)}</span>
      </div>
      {/* Visualization */}
      <div data-testid="compare-panel-visualization" className="min-h-0 flex-1">
        <HistoryCardVisualization
          card={card}
          data={cardData.data}
          selectedView={defaultView}
          isLoading={cardData.isLoading}
          error={cardData.error}
          window={viewport}
        />
      </div>
    </div>
  );
};

// ---------- HistoryCompareGrid ----------

export interface HistoryCompareGridProps {
  cards: HistoryCardSummary[];
  scope: HistoryCardDataScope;
  viewport: HistoryViewport;
  rangeRequest: HistoryRangeSelection;
}

function defaultSelectedIds(cards: HistoryCardSummary[]): string[] {
  // Pre-select the first 2 available cards (or fewer if the list is shorter)
  return cards
    .filter((c) => c.availability.available)
    .slice(0, 2)
    .map((c) => c.cardId);
}

export const HistoryCompareGrid: React.FC<HistoryCompareGridProps> = ({
  cards,
  scope,
  viewport,
  rangeRequest,
}) => {
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>(() =>
    defaultSelectedIds(cards),
  );

  function handleToggle(cardId: string) {
    setSelectedCardIds((prev) => {
      if (prev.includes(cardId)) {
        // Deselect
        return prev.filter((id) => id !== cardId);
      }
      if (prev.length >= MAX_COMPARE_PANELS) {
        // Cap enforced — no-op
        return prev;
      }
      return [...prev, cardId];
    });
  }

  const atMax = selectedCardIds.length >= MAX_COMPARE_PANELS;
  const selectedCards = cards.filter((c) => selectedCardIds.includes(c.cardId));

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Checklist header */}
      <div className="shrink-0 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        <fieldset className="border-none p-0">
          <legend className="sr-only">Select up to {MAX_COMPARE_PANELS} cards to compare</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {cards.map((card) => {
              const isChecked = selectedCardIds.includes(card.cardId);
              // Disable the checkbox when the cap is reached and this card is NOT selected
              const isDisabled = atMax && !isChecked;
              const label = desktopRailCardLabel(card);
              const checkboxId = `compare-check-${card.cardId}`;
              return (
                <label
                  key={card.cardId}
                  htmlFor={checkboxId}
                  className={`flex cursor-pointer items-center gap-1.5 text-sm ${
                    isDisabled ? 'cursor-not-allowed opacity-40' : 'text-[var(--text)]'
                  }`}
                >
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={isChecked}
                    disabled={isDisabled}
                    onChange={() => handleToggle(card.cardId)}
                    aria-label={label}
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                  <span>{label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>

      {/* Panels grid — 1 col on narrow, 2 cols on wider screens */}
      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-3 overflow-auto p-3 sm:grid-cols-2">
        {selectedCards.map((card) => (
          <ComparePanel
            key={card.cardId}
            card={card}
            scope={scope}
            viewport={viewport}
            rangeRequest={rangeRequest}
          />
        ))}
      </div>
    </div>
  );
};
