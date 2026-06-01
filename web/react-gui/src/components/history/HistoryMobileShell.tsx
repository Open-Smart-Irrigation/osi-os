import React from 'react';
import { useTranslation } from 'react-i18next';
import { orderHistoryCards } from '../../history/useHistoryCards';
import { HistoryOverviewCard } from './mobile/HistoryOverviewCard';
import type { HistoryCardSummary } from '../../history/types';
import type { IrrigationZone } from '../../types/farming';

interface HistoryMobileShellProps {
  zones: IrrigationZone[];
  selectedZoneId: number | null;
  onSelectZone: (zoneId: number) => void;
  cards: HistoryCardSummary[];
  onTogglePinned: (cardId: string, pinned: boolean) => void;
}

export const HistoryMobileShell: React.FC<HistoryMobileShellProps> = ({
  zones,
  selectedZoneId,
  onSelectZone,
  cards,
  onTogglePinned,
}) => {
  const { t } = useTranslation('history');
  const orderedCards = orderHistoryCards(cards);

  return (
    <div className="space-y-3 lg:hidden">
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
