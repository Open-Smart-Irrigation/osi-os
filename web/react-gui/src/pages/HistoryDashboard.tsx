import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { HistoryDesktopShell } from '../components/history/HistoryDesktopShell';
import { HistoryMobileShell } from '../components/history/HistoryMobileShell';
import { HistoryMobileHeader } from '../components/history/mobile/HistoryMobileHeader';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../history/useFeatureFlags';
import { useHistoryCards } from '../history/useHistoryCards';
import {
  buildDefaultHistoryWorkspace,
  migrateHistoryWorkspace,
  updateWorkspaceSelectedCards,
  type HistoryWorkspaceContext,
} from '../history/workspaceModel';
import {
  createTimeViewportFromWorkspaceRange,
  useTimeViewport,
  workspaceRangeFromTimeViewport,
  type HistoryTimeViewport,
} from '../history/useTimeViewport';
import { historyAPI, irrigationZonesAPI } from '../services/api';
import type {
  HistoryAdvancedOverlaySettings,
  HistoryCardSummary,
  HistoryOverlayId,
  HistoryViewMode,
  HistoryWorkspace,
  HistoryWorkspaceInspector,
  HistoryWorkspaceRecord,
} from '../history/types';
import type { IrrigationZone } from '../types/farming';

const zonesFetcher = () => irrigationZonesAPI.getAll();

function readIsMobileHistoryViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < 1024;
}

function metadataString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function workspaceRecordZoneId(record: HistoryWorkspaceRecord): number | null {
  return record.zoneId ?? record.workspace.zoneId ?? null;
}

function mergeLiveWorkspaceViewport(
  workspace: HistoryWorkspace,
  viewport: HistoryTimeViewport,
  cards: readonly HistoryCardSummary[],
): HistoryWorkspace {
  const cardById = new Map(cards.map((card) => [card.cardId, card]));
  const viewModesByCard = { ...workspace.viewModesByCard };
  for (const cardId of workspace.selectedCards) {
    const card = cardById.get(cardId);
    if (card && !viewModesByCard[cardId]) {
      viewModesByCard[cardId] = card.defaultView;
    }
  }

  return {
    ...workspace,
    dateRange: workspaceRangeFromTimeViewport(viewport),
    aggregation: viewport.aggregation,
    viewModesByCard,
  };
}

export const HistoryDashboard: React.FC = () => {
  const { username, logout } = useAuth();
  const { t } = useTranslation('history');
  const { t: tc } = useTranslation('common');
  const featureFlags = useFeatureFlags();
  const [selectedZoneId, setSelectedZoneId] = useState<number | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<HistoryWorkspace | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<number | null>(null);
  const [panelCapWarning, setPanelCapWarning] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(readIsMobileHistoryViewport);
  const previousSelectedZoneId = useRef<number | null>(null);

  useEffect(() => {
    const handleResize = () => {
      setIsMobileViewport(readIsMobileHistoryViewport());
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const {
    data: zones,
    error: zonesError,
    isLoading: zonesLoading,
  } = useSWR<IrrigationZone[]>(
    featureFlags.historyEnabled ? '/api/irrigation-zones' : null,
    zonesFetcher,
    {
      revalidateOnFocus: true,
    },
  );

  useEffect(() => {
    if (selectedZoneId === null && zones && zones.length > 0) {
      setSelectedZoneId(zones[0].id);
    }
  }, [selectedZoneId, zones]);

  const {
    cards,
    error: cardsError,
    isLoading: cardsLoading,
    refresh: refreshCards,
  } = useHistoryCards(selectedZoneId, featureFlags.historyEnabled);

  const workspacesEnabled = featureFlags.historyEnabled && featureFlags.flags.historyWorkspacesEnabled;
  const {
    data: workspaceResponse,
    mutate: refreshWorkspaces,
  } = useSWR(
    workspacesEnabled ? '/api/history/workspaces' : null,
    () => historyAPI.getWorkspaces(),
    { revalidateOnFocus: true },
  );
  const visibleWorkspaces = useMemo(
    () => (workspaceResponse?.workspaces ?? []).filter((record) =>
      selectedZoneId !== null && workspaceRecordZoneId(record) === selectedZoneId,
    ),
    [selectedZoneId, workspaceResponse?.workspaces],
  );

  useEffect(() => {
    if (cards.length === 0) {
      setSelectedCardId(null);
      return;
    }
    if (!selectedCardId || !cards.some((card) => card.cardId === selectedCardId)) {
      setSelectedCardId(cards[0].cardId);
    }
  }, [cards, selectedCardId]);

  const selectedCard = useMemo(
    () => cards.find((card) => card.cardId === selectedCardId) ?? null,
    [cards, selectedCardId],
  );

  const workspaceContext = useMemo<HistoryWorkspaceContext>(() => ({
    platform: 'edge',
    farmId: null,
    hubId: null,
    zoneId: selectedZoneId,
    zoneUuid: metadataString(selectedCard?.metadata.zoneUuid),
  }), [selectedCard?.metadata.zoneUuid, selectedZoneId]);

  const defaultWorkspace = useMemo(
    () => buildDefaultHistoryWorkspace({
      cards,
      selectedCardId,
      context: workspaceContext,
      layout: 'single',
    }),
    [cards, selectedCardId, workspaceContext],
  );
  const workspace = activeWorkspace ?? defaultWorkspace;
  const {
    viewport,
    setViewport,
  } = useTimeViewport(workspace.dateRange.label, workspace.selectedCards.join('|') || 'empty');
  const workspaceViewportKey = [
    activeWorkspaceId ?? 'draft',
    workspace.selectedCards.join('|'),
    workspace.dateRange.mode,
    workspace.dateRange.label,
    workspace.dateRange.from ?? '',
    workspace.dateRange.to ?? '',
    workspace.aggregation,
  ].join(':');
  const workspaceForPersist = useMemo(
    () => mergeLiveWorkspaceViewport(workspace, viewport, cards),
    [cards, viewport, workspace],
  );

  useEffect(() => {
    setViewport(createTimeViewportFromWorkspaceRange(
      workspace.dateRange,
      workspace.aggregation,
      new Date(),
      viewport.range.timezone,
    ));
  // Deliberately keyed to workspace-owned viewport fields only. User viewport
  // gestures update `viewport`; they should not be overwritten by this sync.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setViewport, workspaceViewportKey]);

  useEffect(() => {
    if (isMobileViewport || !selectedZoneId || !selectedCardId || !featureFlags.historyEnabled) return;
    historyAPI.markZoneCardOpened(selectedZoneId, selectedCardId).catch(() => undefined);
  }, [featureFlags.historyEnabled, isMobileViewport, selectedCardId, selectedZoneId]);

  useEffect(() => {
    if (previousSelectedZoneId.current === selectedZoneId) return;
    if (previousSelectedZoneId.current === null) {
      previousSelectedZoneId.current = selectedZoneId;
      return;
    }
    previousSelectedZoneId.current = selectedZoneId;
    setActiveWorkspace(null);
    setActiveWorkspaceId(null);
    setPanelCapWarning(false);
  }, [selectedZoneId]);

  const handleSelectCard = (cardId: string) => {
    setSelectedCardId(cardId);
    setPanelCapWarning(false);
    setActiveWorkspace((current) => {
      if (!current || current.layout !== 'single') return current;
      const baseWorkspace = mergeLiveWorkspaceViewport(current, viewport, cards);
      return {
        ...baseWorkspace,
        selectedCards: [cardId],
        panelOrder: [cardId],
      };
    });
  };

  const handleTogglePinned = async (cardId: string, pinned: boolean) => {
    if (!selectedZoneId) return;
    await historyAPI.setZoneCardPreference(selectedZoneId, cardId, { pinned });
    refreshCards();
  };

  const handleWorkspaceLayoutChange = (layout: HistoryWorkspace['layout']) => {
    setPanelCapWarning(false);
    setActiveWorkspace((current) => migrateHistoryWorkspace(
      (() => {
        const base = current ?? defaultWorkspace;
        const fallbackSelectedCardId = selectedCardId ?? cards[0]?.cardId ?? null;
        const fallbackSelection = fallbackSelectedCardId ? [fallbackSelectedCardId] : [];
        return {
          ...mergeLiveWorkspaceViewport(base, viewport, cards),
          layout,
          selectedCards: layout === 'single'
            ? fallbackSelection
            : base.selectedCards.length > 0
              ? base.selectedCards
              : fallbackSelection,
          panelOrder: layout === 'single'
            ? fallbackSelection
            : base.panelOrder.length > 0
              ? base.panelOrder
              : fallbackSelection,
        };
      })(),
      workspaceContext,
    ));
  };

  const handleToggleComparisonCard = (cardId: string, selected: boolean) => {
    setActiveWorkspace((current) => {
      const baseWorkspace = mergeLiveWorkspaceViewport(
        current ?? migrateHistoryWorkspace(
          {
            ...defaultWorkspace,
            layout: 'stacked',
          },
          workspaceContext,
        ),
        viewport,
        cards,
      );
      const result = updateWorkspaceSelectedCards(baseWorkspace, cardId, selected);
      setPanelCapWarning(result.capped);
      return result.workspace;
    });
  };

  const handleLoadWorkspace = (record: HistoryWorkspaceRecord) => {
    if (workspaceRecordZoneId(record) !== selectedZoneId) return;
    const migrated = migrateHistoryWorkspace(record.workspace, workspaceContext);
    setActiveWorkspace(migrated);
    setActiveWorkspaceId(record.id);
    setPanelCapWarning(false);
    const firstAvailableCardId = migrated.selectedCards.find((cardId) => cards.some((card) => card.cardId === cardId));
    setSelectedCardId(firstAvailableCardId ?? migrated.selectedCards[0] ?? null);
  };

  const handleSaveWorkspace = async (name: string) => {
    if (!workspacesEnabled) return;
    const saved = await historyAPI.createWorkspace({
      name,
      zoneId: selectedZoneId,
      workspace: workspaceForPersist,
    });
    setActiveWorkspace(saved.workspace);
    setActiveWorkspaceId(saved.id);
    await refreshWorkspaces();
  };

  const handleUpdateWorkspace = async (name: string) => {
    if (!workspacesEnabled || activeWorkspaceId === null) return;
    const saved = await historyAPI.updateWorkspace(activeWorkspaceId, {
      name,
      zoneId: selectedZoneId,
      workspace: workspaceForPersist,
    });
    setActiveWorkspace(saved.workspace);
    await refreshWorkspaces();
  };

  const handleDeleteWorkspace = async (workspaceId: number) => {
    await historyAPI.deleteWorkspace(workspaceId);
    if (activeWorkspaceId === workspaceId) {
      setActiveWorkspace(null);
      setActiveWorkspaceId(null);
    }
    await refreshWorkspaces();
  };

  const handleViewportChange = (nextViewport: HistoryTimeViewport) => {
    setViewport(nextViewport);
  };

  const updateWorkspaceDraft = (update: (workspace: HistoryWorkspace) => HistoryWorkspace) => {
    setActiveWorkspace((current) => update(mergeLiveWorkspaceViewport(current ?? workspace, viewport, cards)));
  };

  const handleCardViewModeChange = (cardId: string, view: HistoryViewMode) => {
    updateWorkspaceDraft((current) => ({
      ...current,
      viewModesByCard: {
        ...current.viewModesByCard,
        [cardId]: view,
      },
    }));
  };

  const handleCardOverlaysChange = (cardId: string, overlays: HistoryOverlayId[]) => {
    updateWorkspaceDraft((current) => ({
      ...current,
      enabledOverlays: {
        ...current.enabledOverlays,
        [cardId]: overlays,
      },
    }));
  };

  const handleAdvancedOverlaySettingsChange = (
    cardId: string,
    settings: HistoryAdvancedOverlaySettings,
  ) => {
    updateWorkspaceDraft((current) => ({
      ...current,
      advancedOverlaySettings: {
        ...current.advancedOverlaySettings,
        [cardId]: settings,
      },
    }));
  };

  const handlePanelCollapsedChange = (cardId: string, collapsed: boolean) => {
    updateWorkspaceDraft((current) => {
      const collapsedPanels = new Set(current.collapsedPanels);
      if (collapsed) {
        collapsedPanels.add(cardId);
      } else {
        collapsedPanels.delete(cardId);
      }
      return {
        ...current,
        collapsedPanels: Array.from(collapsedPanels),
      };
    });
  };

  const handleInspectorChange = (inspector: HistoryWorkspaceInspector) => {
    updateWorkspaceDraft((current) => ({
      ...current,
      inspector,
    }));
  };

  const availableZones = zones ?? [];
  const shellReady = featureFlags.historyEnabled && availableZones.length > 0 && !zonesError;
  const loadingMessage = featureFlags.historyEnabled && (zonesLoading || cardsLoading)
    ? t('history.shell.loadingLocalCards')
    : null;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {isMobileViewport ? (
        <HistoryMobileHeader onLogout={logout} />
      ) : (
        <header className="bg-[var(--header-bg)] shadow-xl">
          <div className="mx-auto max-w-7xl px-4 py-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h1 className="text-4xl font-bold text-[var(--header-text)] high-contrast-text">
                  {t('history.shell.title')}
                </h1>
                <p className="mt-1 text-lg text-[var(--header-subtext)]">
                  {t('history.shell.subtitle', { username })}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <div className="flex justify-center sm:justify-start">
                  <LanguageSwitcher />
                </div>
                <Link
                  to="/dashboard"
                  className="rounded-lg bg-[var(--secondary-bg)] px-6 py-3 text-center text-lg font-bold text-[var(--text)] transition-colors hover:bg-[var(--border)]"
                >
                  {t('history.nav.legacyDashboard')}
                </Link>
                <button
                  type="button"
                  onClick={logout}
                  className="rounded-lg bg-[var(--secondary-bg)] px-6 py-3 text-lg font-bold text-[var(--text)] transition-colors hover:bg-[var(--border)]"
                >
                  {t('history.nav.logout')}
                </button>
              </div>
            </div>
          </div>
        </header>
      )}

      <main className="mx-auto max-w-7xl px-4 py-4 lg:py-8">
        {!featureFlags.historyEnabled && (
          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6">
            <h2 className="text-2xl font-bold text-[var(--text)]">
              {t('history.shell.unavailableTitle')}
            </h2>
            <p className="mt-2 max-w-2xl text-[var(--text-tertiary)]">
              {t('history.shell.unavailableBody')}
            </p>
            {featureFlags.error && (
              <div className="mt-4">
                <p className="text-sm text-[var(--text-tertiary)]">
                  {t('history.shell.featureFlagFailed')}
                </p>
                <button
                  type="button"
                  onClick={featureFlags.retry}
                  className="mt-3 rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-bold text-white hover:bg-[var(--primary-hover)]"
                >
                  {tc('retry')}
                </button>
              </div>
            )}
          </section>
        )}

        {featureFlags.historyEnabled && zonesError && (
          <section className="rounded-lg border border-[var(--error-bg)] bg-[var(--surface)] p-6">
            <h2 className="text-2xl font-bold text-[var(--text)]">
              {t('history.shell.zonesFailedTitle')}
            </h2>
            <p className="mt-2 text-sm text-[var(--text-tertiary)]">
              {zonesError instanceof Error ? zonesError.message : String(zonesError)}
            </p>
          </section>
        )}

        {featureFlags.historyEnabled && !zonesError && availableZones.length === 0 && !zonesLoading && (
          <section className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-6 text-center">
            <h2 className="text-xl font-bold text-[var(--text)]">
              {t('history.shell.noZonesTitle')}
            </h2>
            <p className="mt-2 text-sm text-[var(--text-tertiary)]">
              {t('history.shell.noZonesBody')}
            </p>
          </section>
        )}

        {loadingMessage && (
          <p className="mb-4 text-sm font-semibold text-[var(--text-tertiary)]">{loadingMessage}</p>
        )}

        {cardsError && (
          <section className="mb-4 rounded-lg border border-[var(--error-bg)] bg-[var(--surface)] p-4">
            <p className="text-sm font-semibold text-[var(--text)]">
              {t('history.shell.cardsFailed')}
            </p>
            <button
              type="button"
              onClick={refreshCards}
              className="mt-3 rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-bold text-white hover:bg-[var(--primary-hover)]"
            >
              {t('history.shell.retryCards')}
            </button>
          </section>
        )}

        {shellReady && (
          isMobileViewport ? (
            <HistoryMobileShell
              zones={availableZones}
              selectedZoneId={selectedZoneId}
              onSelectZone={setSelectedZoneId}
              cards={cards}
              onTogglePinned={handleTogglePinned}
              onRefresh={refreshCards}
            />
          ) : (
            <HistoryDesktopShell
              zones={availableZones}
              selectedZoneId={selectedZoneId}
              onSelectZone={setSelectedZoneId}
              cards={cards}
              selectedCard={selectedCard}
              onSelectCard={handleSelectCard}
              workspace={workspace}
              workspaces={visibleWorkspaces}
              activeWorkspaceId={activeWorkspaceId}
              comparisonEnabled={featureFlags.flags.historyComparisonEnabled}
              workspacesEnabled={featureFlags.flags.historyWorkspacesEnabled}
              panelCapWarning={panelCapWarning}
              viewport={viewport}
              onTogglePinned={handleTogglePinned}
              onLoadWorkspace={handleLoadWorkspace}
              onSaveWorkspace={handleSaveWorkspace}
              onUpdateWorkspace={handleUpdateWorkspace}
              onDeleteWorkspace={handleDeleteWorkspace}
              onWorkspaceLayoutChange={handleWorkspaceLayoutChange}
              onToggleComparisonCard={handleToggleComparisonCard}
              onViewportChange={handleViewportChange}
              onCardViewModeChange={handleCardViewModeChange}
              onCardOverlaysChange={handleCardOverlaysChange}
              onAdvancedOverlaySettingsChange={handleAdvancedOverlaySettingsChange}
              onPanelCollapsedChange={handlePanelCollapsedChange}
              onInspectorChange={handleInspectorChange}
            />
          )
        )}
      </main>
    </div>
  );
};
