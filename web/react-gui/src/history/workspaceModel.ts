import { maxPanelsByPlatform } from './platformLimits';
import { defaultAggregationForRange } from './rangeModel';
import { WorkspaceSchemaVersion } from './types';
import type {
  HistoryAggregationLevel,
  HistoryCardSummary,
  HistoryPlatform,
  HistoryRangeLabel,
  HistoryViewMode,
  HistoryWorkspace,
  HistoryWorkspaceRange,
} from './types';

export interface HistoryWorkspaceContext {
  platform: HistoryPlatform;
  farmId: number | null;
  hubId: string | null;
  zoneId: number | null;
  zoneUuid: string | null;
}

export interface ResolvedWorkspacePanel {
  cardId: string;
  card: HistoryCardSummary | null;
  available: boolean;
}

export interface ResolvedWorkspacePanels {
  panels: ResolvedWorkspacePanel[];
  droppedPanelCount: number;
  maxPanels: number;
}

export interface WorkspaceSelectionUpdate {
  workspace: HistoryWorkspace;
  capped: boolean;
  maxPanels: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

function objectOfStringArrays(value: unknown): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).map(([key, raw]) => [key, stringArray(raw)]),
  );
}

function validRangeLabel(value: unknown): HistoryRangeLabel {
  return value === '12h'
    || value === '24h'
    || value === '7d'
    || value === '30d'
    || value === 'season'
    || value === 'custom'
    ? value
    : '24h';
}

function validAggregation(value: unknown): HistoryAggregationLevel {
  return value === 'auto'
    || value === 'raw'
    || value === '15m'
    || value === 'hourly'
    || value === 'daily'
    || value === 'weekly'
    ? value
    : 'auto';
}

function workspaceRange(value: unknown): HistoryWorkspaceRange {
  const range = asRecord(value);
  const mode = range.mode === 'absolute' ? 'absolute' : 'relative';
  const label = validRangeLabel(range.label);
  return {
    mode,
    label,
    from: typeof range.from === 'string' ? range.from : null,
    to: typeof range.to === 'string' ? range.to : null,
  };
}

function viewModesByCard(value: unknown): Record<string, HistoryViewMode> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).map(([key, raw]) => [key, String(raw) as HistoryViewMode]),
  );
}

export function migrateHistoryWorkspace(
  rawWorkspace: unknown,
  context: HistoryWorkspaceContext,
): HistoryWorkspace {
  const raw = asRecord(rawWorkspace);
  const selectedCards = stringArray(raw.selectedCards ?? raw.selected_cards);
  const panelOrder = stringArray(raw.panelOrder ?? raw.panel_order);
  const layout = raw.layout === 'single' ? 'single' : 'stacked';

  return {
    ...raw,
    schemaVersion: WorkspaceSchemaVersion,
    farmId: typeof raw.farmId === 'number' ? raw.farmId : context.farmId,
    hubId: typeof raw.hubId === 'string' ? raw.hubId : context.hubId,
    zoneId: typeof raw.zoneId === 'number' ? raw.zoneId : context.zoneId,
    zoneUuid: typeof raw.zoneUuid === 'string' ? raw.zoneUuid : context.zoneUuid,
    selectedCards,
    panelOrder: panelOrder.length > 0 ? panelOrder : selectedCards,
    collapsedPanels: stringArray(raw.collapsedPanels ?? raw.collapsed_panels),
    dateRange: workspaceRange(raw.dateRange ?? raw.date_range),
    aggregation: validAggregation(raw.aggregation),
    viewModesByCard: viewModesByCard(raw.viewModesByCard ?? raw.view_modes_by_card),
    enabledOverlays: objectOfStringArrays(raw.enabledOverlays ?? raw.enabled_overlays) as HistoryWorkspace['enabledOverlays'],
    advancedOverlaySettings: asRecord(raw.advancedOverlaySettings ?? raw.advanced_overlay_settings) as HistoryWorkspace['advancedOverlaySettings'],
    limits: {
      platform: context.platform,
      maxPanels: maxPanelsByPlatform[context.platform],
    },
    inspector: {
      selectedTimestamp: typeof asRecord(raw.inspector).selectedTimestamp === 'string'
        ? String(asRecord(raw.inspector).selectedTimestamp)
        : null,
      open: asRecord(raw.inspector).open !== false,
    },
    pinnedCards: stringArray(raw.pinnedCards ?? raw.pinned_cards),
    layout,
  };
}

export function buildDefaultHistoryWorkspace(args: {
  cards: HistoryCardSummary[];
  selectedCardId: string | null;
  context: HistoryWorkspaceContext;
  layout?: HistoryWorkspace['layout'];
}): HistoryWorkspace {
  const selectedCardId = args.selectedCardId ?? args.cards[0]?.cardId ?? null;
  const selectedCards = selectedCardId ? [selectedCardId] : [];
  const selectedCard = args.cards.find((card) => card.cardId === selectedCardId) ?? args.cards[0] ?? null;
  const defaultRange = selectedCard?.defaultRange ?? '24h';
  return migrateHistoryWorkspace(
    {
      selectedCards,
      panelOrder: selectedCards,
      pinnedCards: args.cards.filter((card) => card.ordering.pinned).map((card) => card.cardId),
      collapsedPanels: [],
      dateRange: { mode: 'relative', label: defaultRange, from: null, to: null },
      aggregation: defaultAggregationForRange(defaultRange),
      viewModesByCard: selectedCard ? { [selectedCard.cardId]: selectedCard.defaultView } : {},
      enabledOverlays: {},
      advancedOverlaySettings: {},
      inspector: { selectedTimestamp: null, open: true },
      layout: args.layout ?? 'single',
    },
    args.context,
  );
}

function orderedSelectedCardIds(workspace: HistoryWorkspace): string[] {
  const selected = new Set(workspace.selectedCards);
  const ordered = workspace.panelOrder.filter((cardId) => selected.has(cardId));
  for (const cardId of workspace.selectedCards) {
    if (!ordered.includes(cardId)) ordered.push(cardId);
  }
  return ordered;
}

export function resolveWorkspacePanels(
  workspace: HistoryWorkspace,
  cards: HistoryCardSummary[],
): ResolvedWorkspacePanels {
  const cardById = new Map(cards.map((card) => [card.cardId, card]));
  const orderedCardIds = orderedSelectedCardIds(workspace);
  const maxPanels = workspace.limits.maxPanels;
  const cappedCardIds = orderedCardIds.slice(0, maxPanels);

  return {
    panels: cappedCardIds.map((cardId) => {
      const card = cardById.get(cardId) ?? null;
      return {
        cardId,
        card,
        available: Boolean(card),
      };
    }),
    droppedPanelCount: Math.max(0, orderedCardIds.length - maxPanels),
    maxPanels,
  };
}

export function updateWorkspaceSelectedCards(
  workspace: HistoryWorkspace,
  cardId: string,
  selected: boolean,
): WorkspaceSelectionUpdate {
  const selectedCards = orderedSelectedCardIds(workspace);
  const currentlySelected = selectedCards.includes(cardId);
  const maxPanels = workspace.limits.maxPanels;

  if (selected && !currentlySelected && selectedCards.length >= maxPanels) {
    return { workspace, capped: true, maxPanels };
  }

  const nextSelectedCards = selected
    ? currentlySelected ? selectedCards : [...selectedCards, cardId]
    : selectedCards.filter((existingCardId) => existingCardId !== cardId);

  return {
    capped: false,
    maxPanels,
    workspace: {
      ...workspace,
      layout: workspace.layout === 'single' && nextSelectedCards.length > 1 ? 'stacked' : workspace.layout,
      selectedCards: nextSelectedCards,
      panelOrder: nextSelectedCards,
    },
  };
}
