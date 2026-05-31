import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TimelineBrush } from './TimelineBrush';
import { useHistoryCardData, type HistoryCardDataScope } from '../../history/useHistoryCardData';
import { useTimeViewport } from '../../history/useTimeViewport';
import type {
  CoverageConfidence,
  HistoryCardSummary,
  HistoryCardType,
  HistorySyncState,
  HistoryViewMode,
} from '../../history/types';

interface HistoryCardFrameProps {
  card: HistoryCardSummary | null;
  scope: HistoryCardDataScope | null;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function formatCoverage(
  t: HistoryTranslate,
  coveragePct: number | null | undefined,
): string {
  if (coveragePct === null || coveragePct === undefined) return t('history.metadata.coverageUnknown');
  return t('history.metadata.coverageKnown', { coverage: Math.round(coveragePct) });
}

function formatViewLabel(t: HistoryTranslate, view: HistoryViewMode): string {
  return t(`history.viewMode.${view}`);
}

function formatCardType(t: HistoryTranslate, cardType: HistoryCardType): string {
  return t(`history.cardType.${cardType}`);
}

function formatCoverageConfidence(t: HistoryTranslate, value: CoverageConfidence): string {
  return t(`history.metadata.coverageConfidence.${value}`);
}

function formatSyncState(t: HistoryTranslate, value: HistorySyncState): string {
  return t(`history.metadata.syncState.${value}`);
}

export const HistoryCardFrame: React.FC<HistoryCardFrameProps> = ({ card, scope }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const [viewModesByCard, setViewModesByCard] = useState<Record<string, HistoryViewMode>>({});
  const defaultRange = card?.defaultRange ?? '24h';
  const { viewport, setViewport } = useTimeViewport(defaultRange, card?.cardId ?? 'empty');
  const selectedView = card ? viewModesByCard[card.cardId] ?? card.defaultView : 'line-chart';
  const cardData = useHistoryCardData({
    scope,
    cardId: card?.cardId ?? null,
    view: selectedView,
    range: viewport.range,
    aggregation: viewport.aggregation,
    overlays: [],
    enabled: Boolean(card?.availability.available),
  });

  if (!card) {
    return (
      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-6 min-h-[22rem] flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold text-[var(--text)]">
            {t('history.cardFrame.emptyTitle')}
          </h2>
          <p className="mt-2 text-sm text-[var(--text-tertiary)]">
            {t('history.cardFrame.emptyBody')}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg min-h-[22rem] overflow-hidden">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
              {t('history.cardFrame.typeHistory', { cardType: formatCardType(t, card.cardType) })}
            </p>
            <h2 className="mt-1 text-2xl font-bold text-[var(--text)]">{card.title}</h2>
            {card.subtitle && (
              <p className="mt-1 text-sm text-[var(--text-tertiary)]">{card.subtitle}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-[var(--text)]">
              {formatCoverage(t, card.metadata.coveragePct)}
            </span>
            <span className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-[var(--text)]">
              {formatCoverageConfidence(t, card.metadata.coverageConfidence)}
            </span>
            {card.metadata.syncState && (
              <span className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-[var(--text)]">
                {formatSyncState(t, card.metadata.syncState)}
              </span>
            )}
            {cardData.data && (
              <span className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-[var(--text)]">
                {t('history.cardFrame.aggregationBadge', { aggregation: cardData.data.aggregation.level })}
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2" aria-label={t('history.cardFrame.viewModes', { title: card.title })}>
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
              {formatViewLabel(t, view)}
            </button>
          ))}
        </div>
      </div>

      <div className="p-5">
        {!card.availability.available && (
          <div className="mb-4 rounded-lg border border-[var(--warning-bg)] bg-[var(--warning-bg)] px-4 py-3 text-sm text-[var(--warning-text)]">
            {t('history.cardFrame.unavailable')}
          </div>
        )}

        <TimelineBrush
          viewport={viewport}
          defaultRange={card.defaultRange}
          onViewportChange={setViewport}
          ariaLabel={t('history.cardFrame.timelineBrush')}
          keyboardHelp={t('history.cardFrame.timelineBrushKeyboardHelp')}
        />

        <div className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6">
          <p className="text-sm font-semibold text-[var(--text)]">{formatViewLabel(t, selectedView)}</p>
          <p className="mt-2 text-sm text-[var(--text-tertiary)]">
            {t('history.cardFrame.placeholderBody')}
          </p>
        </div>
      </div>
    </section>
  );
};
