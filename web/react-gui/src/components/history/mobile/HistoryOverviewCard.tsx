import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatHistorySourceLabel } from '../../../history/sourceLabels';
import type { HistoryCardSummary, HistoryCardType, HistorySyncState } from '../../../history/types';

interface HistoryOverviewCardProps {
  zoneId: number;
  card: HistoryCardSummary;
  onTogglePinned?: (cardId: string, pinned: boolean) => void;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;
const GATEWAY_ROUTE_CARD_ID = 'gateway-hub';

function cardTypeLabel(t: HistoryTranslate, cardType: HistoryCardType): string {
  return t('history.overview.cardTypeLabel', {
    cardType: t(`history.cardType.${cardType}`),
  });
}

function coverageLabel(t: HistoryTranslate, card: HistoryCardSummary): string {
  const coveragePct = card.metadata.coveragePct;
  return coveragePct === null || coveragePct === undefined
    ? t('history.metadata.coverageUnknown')
    : t('history.metadata.coverageKnown', { coverage: Math.round(coveragePct) });
}

function syncLabel(t: HistoryTranslate, syncState: HistorySyncState | undefined): string {
  return t(`history.metadata.syncState.${syncState ?? 'unknown'}`);
}

function isRawIdentifierLabel(label: string): boolean {
  return /^[a-f0-9]{16}$/i.test(label.trim());
}

function displaySafeSourceLabel(label: string | null): string | null {
  if (!label || isRawIdentifierLabel(label)) return null;
  return label;
}

function detailPath(zoneId: number, card: HistoryCardSummary): string {
  if (card.scope === 'gateway') {
    return `/history/zones/${zoneId}/cards/${GATEWAY_ROUTE_CARD_ID}`;
  }
  return `/history/zones/${zoneId}/cards/${encodeURIComponent(card.cardId)}`;
}

export const HistoryOverviewCard: React.FC<HistoryOverviewCardProps> = ({
  zoneId,
  card,
  onTogglePinned,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const sourceLabel = displaySafeSourceLabel(formatHistorySourceLabel(t, card));
  const pinned = card.ordering.pinned;

  return (
    <article className="relative rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
      <Link
        to={detailPath(zoneId, card)}
        aria-label={t('history.overview.openCard', { title: card.title })}
        className="absolute inset-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--primary)] focus:ring-offset-2 focus:ring-offset-[var(--bg)]"
      />

      <div className="relative pointer-events-none">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
              {cardTypeLabel(t, card.cardType)}
            </p>
            <h2 className="mt-1 text-xl font-bold leading-tight text-[var(--text)]">
              {card.title}
            </h2>
          </div>
          {onTogglePinned && (
            <button
              type="button"
              aria-label={pinned
                ? t('history.overview.unpinCardForTitle', { title: card.title })
                : t('history.overview.pinCardForTitle', { title: card.title })}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onTogglePinned(card.cardId, !pinned);
              }}
              className="pointer-events-auto relative z-10 shrink-0 rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-2.5 py-1.5 text-xs font-bold text-[var(--text)]"
            >
              {pinned ? t('history.sidebar.unpinCard') : t('history.sidebar.pinCard')}
            </button>
          )}
        </div>

        {card.subtitle && (
          <p className="mt-2 text-sm leading-snug text-[var(--text-tertiary)]">
            {card.subtitle}
          </p>
        )}
        {sourceLabel && (
          <p className="mt-2 text-sm font-semibold text-[var(--text)]">{sourceLabel}</p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <span className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs font-semibold text-[var(--text-tertiary)]">
            {coverageLabel(t, card)}
          </span>
          <span className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs font-semibold text-[var(--text-tertiary)]">
            {syncLabel(t, card.metadata.syncState)}
          </span>
          {pinned && (
            <span className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-xs font-semibold text-[var(--text)]">
              {t('history.overview.pinned')}
            </span>
          )}
          {card.ordering.criticalAlert && (
            <span className="rounded-md border border-[var(--warning-bg)] bg-[var(--warning-bg)] px-2 py-1 text-xs font-semibold text-[var(--warning-text)]">
              {t('history.overview.alert')}
            </span>
          )}
        </div>
      </div>
    </article>
  );
};
