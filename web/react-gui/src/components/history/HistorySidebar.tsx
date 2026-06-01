import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { orderHistoryCards } from '../../history/useHistoryCards';
import type { HistoryCardSummary, HistoryWorkspaceRecord } from '../../history/types';
import type { IrrigationZone } from '../../types/farming';

interface HistorySidebarProps {
  zones: IrrigationZone[];
  selectedZoneId: number | null;
  onSelectZone: (zoneId: number) => void;
  cards: HistoryCardSummary[];
  selectedCardId: string | null;
  onSelectCard: (cardId: string) => void;
  workspaces?: HistoryWorkspaceRecord[];
  activeWorkspaceId?: number | null;
  workspacesEnabled?: boolean;
  onTogglePinned?: (cardId: string, pinned: boolean) => void;
  onLoadWorkspace?: (workspace: HistoryWorkspaceRecord) => void;
  onSaveWorkspace?: (name: string) => void;
  onUpdateWorkspace?: (name: string) => void;
  onDeleteWorkspace?: (workspaceId: number) => void;
}

export const HistorySidebar: React.FC<HistorySidebarProps> = ({
  zones,
  selectedZoneId,
  onSelectZone,
  cards,
  selectedCardId,
  onSelectCard,
  workspaces = [],
  activeWorkspaceId = null,
  workspacesEnabled = false,
  onTogglePinned,
  onLoadWorkspace,
  onSaveWorkspace,
  onUpdateWorkspace,
  onDeleteWorkspace,
}) => {
  const { t } = useTranslation('history');
  const [workspaceName, setWorkspaceName] = useState(t('history.sidebar.defaultWorkspaceName'));
  const orderedCards = orderHistoryCards(cards);
  const pinnedCards = orderedCards.filter((card) => card.ordering.pinned);
  const availableCards = orderedCards.filter((card) => !card.ordering.pinned);
  const canUpdateWorkspace = activeWorkspaceId !== null && Boolean(onUpdateWorkspace);

  return (
    <aside className="h-full border-r border-[var(--border)] bg-[var(--surface)] p-4">
      <section>
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('history.sidebar.zones')}
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
          {t('history.sidebar.pinnedCards')}
        </h2>
        <CardList
          cards={pinnedCards}
          selectedCardId={selectedCardId}
          onSelectCard={onSelectCard}
          onTogglePinned={onTogglePinned}
          pinLabel={t('history.sidebar.pinCard')}
          unpinLabel={t('history.sidebar.unpinCard')}
          emptyLabel={t('history.sidebar.none')}
          cardAriaLabel={(title) => t('history.carousel.cardAriaLabel', { title })}
        />
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('history.sidebar.availableCards')}
        </h2>
        <CardList
          cards={availableCards}
          selectedCardId={selectedCardId}
          onSelectCard={onSelectCard}
          onTogglePinned={onTogglePinned}
          pinLabel={t('history.sidebar.pinCard')}
          unpinLabel={t('history.sidebar.unpinCard')}
          emptyLabel={t('history.sidebar.none')}
          cardAriaLabel={(title) => t('history.carousel.cardAriaLabel', { title })}
        />
      </section>

      <section className="mt-6 rounded-lg border border-dashed border-[var(--border)] p-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('history.sidebar.savedWorkspaces')}
        </h2>
        {!workspacesEnabled && (
          <p className="mt-2 text-xs text-[var(--text-tertiary)]">{t('history.sidebar.workspaceDisabled')}</p>
        )}
        {workspacesEnabled && (
          <div className="mt-3 space-y-3">
            <label className="block">
              <span className="text-xs font-semibold text-[var(--text-tertiary)]">
                {t('history.sidebar.workspaceName')}
              </span>
              <input
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-2 text-sm text-[var(--text)]"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onSaveWorkspace?.(workspaceName)}
                className="rounded-md border border-[var(--border)] px-2 py-2 text-xs font-semibold text-[var(--text)] hover:bg-[var(--secondary-bg)]"
              >
                {t('history.sidebar.saveWorkspace')}
              </button>
              <button
                type="button"
                disabled={!canUpdateWorkspace}
                onClick={() => onUpdateWorkspace?.(workspaceName)}
                className="rounded-md border border-[var(--border)] px-2 py-2 text-xs font-semibold text-[var(--text)] hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('history.sidebar.updateWorkspace')}
              </button>
            </div>
            {workspaces.length === 0 && (
              <p className="text-xs text-[var(--text-tertiary)]">{t('history.sidebar.none')}</p>
            )}
            {workspaces.map((workspace) => (
              <div key={workspace.id} className="rounded-md border border-[var(--border)] p-2">
                <p className="text-sm font-semibold text-[var(--text)]">{workspace.name}</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setWorkspaceName(workspace.name);
                      onLoadWorkspace?.(workspace);
                    }}
                    className="rounded-md border border-[var(--border)] px-2 py-1.5 text-xs font-semibold text-[var(--text)] hover:bg-[var(--secondary-bg)]"
                  >
                    {t('history.sidebar.loadWorkspace', { name: workspace.name })}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteWorkspace?.(workspace.id)}
                    className="rounded-md border border-[var(--border)] px-2 py-1.5 text-xs font-semibold text-[var(--text)] hover:bg-[var(--secondary-bg)]"
                  >
                    {t('history.sidebar.deleteWorkspace', { name: workspace.name })}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
};

interface CardListProps {
  cards: HistoryCardSummary[];
  selectedCardId: string | null;
  onSelectCard: (cardId: string) => void;
  onTogglePinned?: (cardId: string, pinned: boolean) => void;
  pinLabel: string;
  unpinLabel: string;
  emptyLabel: string;
  cardAriaLabel: (title: string) => string;
}

const CardList: React.FC<CardListProps> = ({
  cards,
  selectedCardId,
  onSelectCard,
  onTogglePinned,
  pinLabel,
  unpinLabel,
  emptyLabel,
  cardAriaLabel,
}) => {
  if (cards.length === 0) {
    return <p className="mt-3 text-xs text-[var(--text-tertiary)]">{emptyLabel}</p>;
  }

  return (
    <div className="mt-3 space-y-2">
      {cards.map((card) => (
        <div
          key={card.cardId}
          className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
            card.cardId === selectedCardId
              ? 'border-[var(--primary)] bg-[var(--secondary-bg)]'
              : 'border-[var(--border)] hover:bg-[var(--secondary-bg)]'
          }`}
        >
          <button
            type="button"
            aria-label={cardAriaLabel(card.title)}
            aria-pressed={card.cardId === selectedCardId}
            onClick={() => onSelectCard(card.cardId)}
            className="block w-full text-left"
          >
            <span className="block text-sm font-semibold text-[var(--text)]">{card.title}</span>
            {card.subtitle && (
              <span className="mt-1 block text-xs text-[var(--text-tertiary)]">{card.subtitle}</span>
            )}
          </button>
          {onTogglePinned && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onTogglePinned(card.cardId, !card.ordering.pinned);
              }}
              className="mt-2 inline-flex rounded-md border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--text-tertiary)]"
            >
              {card.ordering.pinned ? unpinLabel : pinLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  );
};
