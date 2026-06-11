import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { orderHistoryCards } from '../../history/useHistoryCards';
import { HistoryOverviewCard } from './mobile/HistoryOverviewCard';
import type { HistoryCardSummary } from '../../history/types';
import type { IrrigationZone } from '../../types/farming';

const OVERVIEW_PULL_REFRESH_THRESHOLD_PX = 96;
const OVERVIEW_PULL_REFRESH_MAX_HORIZONTAL_PX = 48;

interface HistoryMobileShellProps {
  zones: IrrigationZone[];
  selectedZoneId: number | null;
  onSelectZone: (zoneId: number) => void;
  cards: HistoryCardSummary[];
  onTogglePinned: (cardId: string, pinned: boolean) => void;
  onRefresh?: () => void;
}

type PullRefreshStart = {
  pointerId: number;
  x: number;
  y: number;
  refreshed: boolean;
};

function isPullRefreshPointerType(pointerType: string): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('a, button, input, select, textarea, [role="button"]'));
}

export const HistoryMobileShell: React.FC<HistoryMobileShellProps> = ({
  zones,
  selectedZoneId,
  onSelectZone,
  cards,
  onTogglePinned,
  onRefresh,
}) => {
  const { t } = useTranslation('history');
  const pullStartRef = useRef<PullRefreshStart | null>(null);
  const orderedCards = orderHistoryCards(cards);
  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (
      !onRefresh
      || !isPullRefreshPointerType(event.pointerType)
      || isInteractiveTarget(event.target)
      || Math.max(window.scrollY, document.documentElement.scrollTop, document.body.scrollTop) > 2
    ) {
      pullStartRef.current = null;
      return;
    }

    pullStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      refreshed: false,
    };
  }, [onRefresh]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const start = pullStartRef.current;
    if (
      !onRefresh
      || !start
      || start.pointerId !== event.pointerId
      || start.refreshed
      || !isPullRefreshPointerType(event.pointerType)
    ) {
      pullStartRef.current = null;
      return;
    }

    const deltaY = event.clientY - start.y;
    const deltaX = Math.abs(event.clientX - start.x);
    if (deltaY >= OVERVIEW_PULL_REFRESH_THRESHOLD_PX && deltaX <= OVERVIEW_PULL_REFRESH_MAX_HORIZONTAL_PX) {
      start.refreshed = true;
      onRefresh();
    }
    pullStartRef.current = null;
  }, [onRefresh]);

  return (
    <div
      data-testid="history-mobile-shell"
      className="space-y-3 lg:hidden"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        pullStartRef.current = null;
      }}
    >
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('history.mobile.zoneLabel')}
        </span>
        <select
          className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-[var(--text)]"
          value={selectedZoneId ?? ''}
          onChange={(event) => onSelectZone(Number(event.target.value))}
        >
          {zones.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zone.name}
            </option>
          ))}
        </select>
      </label>

      {orderedCards.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--text-tertiary)]">
          {t('history.overview.empty')}
        </div>
      ) : (
        <div className="space-y-3">
          {orderedCards.map((card) => (
            <HistoryOverviewCard
              key={card.cardId}
              zoneId={selectedZoneId ?? 0}
              card={card}
              onTogglePinned={onTogglePinned}
            />
          ))}
        </div>
      )}
    </div>
  );
};
