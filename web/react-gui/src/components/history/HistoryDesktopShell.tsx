import React from 'react';
import { useTranslation } from 'react-i18next';
import { HistoryCardFrame } from './HistoryCardFrame';
import { HistorySidebar } from './HistorySidebar';
import { maxPanelsByPlatform } from '../../history/platformLimits';
import { resolveWorkspacePanels } from '../../history/workspaceModel';
import { useTimeViewport } from '../../history/useTimeViewport';
import type { HistoryCardSummary, HistoryWorkspace, HistoryWorkspaceRecord } from '../../history/types';
import type { IrrigationZone } from '../../types/farming';

interface HistoryDesktopShellProps {
  zones: IrrigationZone[];
  selectedZoneId: number | null;
  onSelectZone: (zoneId: number) => void;
  cards: HistoryCardSummary[];
  selectedCard: HistoryCardSummary | null;
  onSelectCard: (cardId: string) => void;
  workspace: HistoryWorkspace;
  workspaces: HistoryWorkspaceRecord[];
  activeWorkspaceId: number | null;
  comparisonEnabled: boolean;
  workspacesEnabled: boolean;
  panelCapWarning: boolean;
  onTogglePinned: (cardId: string, pinned: boolean) => void;
  onLoadWorkspace: (workspace: HistoryWorkspaceRecord) => void;
  onSaveWorkspace: (name: string) => void;
  onUpdateWorkspace: (name: string) => void;
  onDeleteWorkspace: (workspaceId: number) => void;
  onWorkspaceLayoutChange: (layout: HistoryWorkspace['layout']) => void;
  onToggleComparisonCard: (cardId: string, selected: boolean) => void;
}

export const HistoryDesktopShell: React.FC<HistoryDesktopShellProps> = ({
  zones,
  selectedZoneId,
  onSelectZone,
  cards,
  selectedCard,
  onSelectCard,
  workspace,
  workspaces,
  activeWorkspaceId,
  comparisonEnabled,
  workspacesEnabled,
  panelCapWarning,
  onTogglePinned,
  onLoadWorkspace,
  onSaveWorkspace,
  onUpdateWorkspace,
  onDeleteWorkspace,
  onWorkspaceLayoutChange,
  onToggleComparisonCard,
}) => {
  const { t } = useTranslation('history');
  const defaultRange = selectedCard?.defaultRange ?? workspace.dateRange.label;
  const { viewport, setViewport } = useTimeViewport(defaultRange, workspace.selectedCards.join('|') || 'empty');
  const resolvedPanels = resolveWorkspacePanels(workspace, cards);
  const selectedCards = new Set(workspace.selectedCards);
  const showPanelLimitWarning = panelCapWarning || resolvedPanels.droppedPanelCount > 0;
  const selectedTimestamp = workspace.inspector.selectedTimestamp;

  return (
    <div className="hidden min-h-[42rem] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)] lg:grid lg:grid-cols-[18rem_minmax(0,1fr)_18rem]">
      <HistorySidebar
        zones={zones}
        selectedZoneId={selectedZoneId}
        onSelectZone={onSelectZone}
        cards={cards}
        selectedCardId={selectedCard?.cardId ?? null}
        onSelectCard={onSelectCard}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        workspacesEnabled={workspacesEnabled}
        onTogglePinned={onTogglePinned}
        onLoadWorkspace={onLoadWorkspace}
        onSaveWorkspace={onSaveWorkspace}
        onUpdateWorkspace={onUpdateWorkspace}
        onDeleteWorkspace={onDeleteWorkspace}
      />

      <main className="min-w-0 p-4">
        <div className="mb-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
                {t('history.desktop.toolbarTitle')}
              </p>
              <p className="mt-1 text-sm text-[var(--text-tertiary)]">
                {t('history.desktop.toolbarPlaceholder')}
              </p>
              <p className="mt-2 text-xs font-semibold text-[var(--text-tertiary)]">
                {t('history.desktop.maxPanels', { count: maxPanelsByPlatform.edge })}
              </p>
            </div>
            {comparisonEnabled && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={workspace.layout === 'single'}
                  onClick={() => onWorkspaceLayoutChange('single')}
                  className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                    workspace.layout === 'single'
                      ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
                      : 'border-[var(--border)] text-[var(--text)] hover:bg-[var(--secondary-bg)]'
                  }`}
                >
                  {t('history.desktop.singleMode')}
                </button>
                <button
                  type="button"
                  aria-pressed={workspace.layout === 'stacked'}
                  onClick={() => onWorkspaceLayoutChange('stacked')}
                  className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                    workspace.layout === 'stacked'
                      ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
                      : 'border-[var(--border)] text-[var(--text)] hover:bg-[var(--secondary-bg)]'
                  }`}
                >
                  {t('history.desktop.comparisonMode')}
                </button>
              </div>
            )}
          </div>
          {comparisonEnabled && workspace.layout === 'stacked' && (
            <div className="mt-3 flex flex-wrap gap-2">
              {cards.map((card) => (
                <button
                  key={card.cardId}
                  type="button"
                  aria-pressed={selectedCards.has(card.cardId)}
                  onClick={() => onToggleComparisonCard(card.cardId, !selectedCards.has(card.cardId))}
                  className={`rounded-md border px-2 py-1.5 text-xs font-semibold ${
                    selectedCards.has(card.cardId)
                      ? 'border-[var(--primary)] bg-[var(--secondary-bg)] text-[var(--text)]'
                      : 'border-[var(--border)] text-[var(--text-tertiary)] hover:bg-[var(--secondary-bg)]'
                  }`}
                >
                  {selectedCards.has(card.cardId)
                    ? t('history.desktop.removePanel')
                    : t('history.desktop.addPanel', { title: card.title })}
                </button>
              ))}
            </div>
          )}
          {showPanelLimitWarning && (
            <p className="mt-3 rounded-md border border-[var(--warning-bg)] bg-[var(--warning-bg)] px-3 py-2 text-xs font-semibold text-[var(--warning-text)]">
              {t('history.desktop.panelLimitWarning', { count: maxPanelsByPlatform.edge })}
            </p>
          )}
        </div>
        {workspace.layout === 'stacked' ? (
          <div className="space-y-4">
            {resolvedPanels.panels.map((panel) => (
              <div key={panel.cardId} data-testid="history-comparison-panel">
                {panel.available ? (
                  <HistoryCardFrame
                    card={panel.card}
                    scope={selectedZoneId === null ? null : { type: 'zone', zoneId: selectedZoneId }}
                    viewport={viewport}
                    onViewportChange={setViewport}
                  />
                ) : (
                  <section className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-5">
                    <p className="text-sm font-semibold text-[var(--text)]">
                      {t('history.workspace.unavailablePanel', { cardId: panel.cardId })}
                    </p>
                    <button
                      type="button"
                      onClick={() => onToggleComparisonCard(panel.cardId, false)}
                      className="mt-3 rounded-md border border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--text)] hover:bg-[var(--secondary-bg)]"
                    >
                      {t('history.workspace.repairPanel')}
                    </button>
                  </section>
                )}
              </div>
            ))}
          </div>
        ) : (
          <HistoryCardFrame
            card={selectedCard}
            scope={selectedZoneId === null ? null : { type: 'zone', zoneId: selectedZoneId }}
            viewport={viewport}
            onViewportChange={setViewport}
          />
        )}
      </main>

      <aside className="border-l border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('history.desktop.inspectorTitle')}
        </h2>
        <p className="mt-3 text-sm text-[var(--text-tertiary)]">
          {t('history.desktop.inspectorPlaceholder')}
        </p>
        <p className="mt-4 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-semibold text-[var(--text)]">
          {selectedTimestamp
            ? t('history.desktop.selectedTimestamp', { timestamp: selectedTimestamp })
            : t('history.desktop.selectedTimestampNone')}
        </p>
      </aside>
    </div>
  );
};
