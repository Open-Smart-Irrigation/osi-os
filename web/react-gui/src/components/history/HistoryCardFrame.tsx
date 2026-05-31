import React, { useState } from 'react';
import type { HistoryCardSummary, HistoryViewMode } from '../../history/types';

interface HistoryCardFrameProps {
  card: HistoryCardSummary | null;
}

function formatCoverage(coveragePct: number | null | undefined): string {
  if (coveragePct === null || coveragePct === undefined) return 'Coverage unknown';
  return `${Math.round(coveragePct)}% coverage`;
}

function formatViewLabel(view: HistoryViewMode): string {
  return view
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export const HistoryCardFrame: React.FC<HistoryCardFrameProps> = ({ card }) => {
  const [viewModesByCard, setViewModesByCard] = useState<Record<string, HistoryViewMode>>({});

  if (!card) {
    return (
      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-6 min-h-[22rem] flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold text-[var(--text)]">Select a history card</h2>
          <p className="mt-2 text-sm text-[var(--text-tertiary)]">
            Choose a zone and thematic card to inspect local history.
          </p>
        </div>
      </section>
    );
  }

  const selectedView = viewModesByCard[card.cardId] ?? card.defaultView;

  return (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg min-h-[22rem] overflow-hidden">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
              {card.cardType} history
            </p>
            <h2 className="mt-1 text-2xl font-bold text-[var(--text)]">{card.title}</h2>
            {card.subtitle && (
              <p className="mt-1 text-sm text-[var(--text-tertiary)]">{card.subtitle}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-[var(--text)]">
              {formatCoverage(card.metadata.coveragePct)}
            </span>
            <span className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-[var(--text)]">
              {card.metadata.coverageConfidence}
            </span>
            {card.metadata.syncState && (
              <span className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-[var(--text)]">
                {card.metadata.syncState}
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2" aria-label={`${card.title} view modes`}>
          {card.views.map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={selectedView === view}
              onClick={() => setViewModesByCard((current) => ({ ...current, [card.cardId]: view }))}
              className={`rounded-md border px-3 py-2 text-sm font-semibold transition-colors ${
                selectedView === view
                  ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
                  : 'border-[var(--border)] bg-[var(--secondary-bg)] text-[var(--text)] hover:bg-[var(--border)]'
              }`}
            >
              {formatViewLabel(view)}
            </button>
          ))}
        </div>
      </div>

      <div className="p-5">
        {!card.availability.available && (
          <div className="mb-4 rounded-lg border border-[var(--warning-bg)] bg-[var(--warning-bg)] px-4 py-3 text-sm text-[var(--warning-text)]">
            This card is not available for the selected zone.
          </div>
        )}

        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6">
          <p className="text-sm font-semibold text-[var(--text)]">{formatViewLabel(selectedView)}</p>
          <p className="mt-2 text-sm text-[var(--text-tertiary)]">
            Chart and calendar data will load here when card data APIs are enabled.
          </p>
        </div>
      </div>
    </section>
  );
};
