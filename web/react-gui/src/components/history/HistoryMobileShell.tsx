import React from 'react';
import { useTranslation } from 'react-i18next';
import { HistoryCardFrame } from './HistoryCardFrame';
import { ThematicCardCarousel } from './ThematicCardCarousel';
import type { HistoryCardSummary } from '../../history/types';
import type { IrrigationZone } from '../../types/farming';

interface HistoryMobileShellProps {
  zones: IrrigationZone[];
  selectedZoneId: number | null;
  onSelectZone: (zoneId: number) => void;
  cards: HistoryCardSummary[];
  selectedCard: HistoryCardSummary | null;
  onSelectCard: (cardId: string) => void;
}

export const HistoryMobileShell: React.FC<HistoryMobileShellProps> = ({
  zones,
  selectedZoneId,
  onSelectZone,
  cards,
  selectedCard,
  onSelectCard,
}) => {
  const { t } = useTranslation('history');

  return (
    <div className="space-y-4 lg:hidden">
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

      <ThematicCardCarousel
        cards={cards}
        selectedCardId={selectedCard?.cardId ?? null}
        onSelectCard={onSelectCard}
      />

      <HistoryCardFrame card={selectedCard} />
    </div>
  );
};
