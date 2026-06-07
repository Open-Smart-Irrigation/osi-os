import { historyCardDefinitionsByType } from './cardDefinitions';
import type { ViewportBounds } from './historyViewport';
import type { HistoryCardSummary, HistoryViewMode } from './types';

export interface DesktopSourceOption {
  key: string | null;
  label: string;
}

export interface DesktopViewOption {
  view: HistoryViewMode;
  labelKey: string;
}

function cleanText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isRawHistoryIdentifier(value: string | null | undefined): boolean {
  const text = cleanText(value);
  return /^[A-Fa-f0-9]{16}$/.test(text)
    || /\b(?:soil|dendro|environment|gateway)-src-[a-z0-9-]+\b/i.test(text);
}

export function safeHistoryLabel(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text || isRawHistoryIdentifier(text)) return null;
  return text;
}

function sourceCount(card: HistoryCardSummary): number {
  return card.sourceDeviceCount
    ?? card.sourceDevices?.length
    ?? card.sourceLabels?.length
    ?? 0;
}

function singleSourceLabel(card: HistoryCardSummary): string | null {
  if (sourceCount(card) !== 1) return null;
  return safeHistoryLabel(card.sourceLabel ?? card.sourceLabels?.[0] ?? card.sourceDevices?.[0]?.name);
}

function titleWithoutThemePrefix(card: HistoryCardSummary): string {
  const title = safeHistoryLabel(card.title) ?? card.cardType;
  if (card.cardType === 'dendro') return title.replace(/^Dendro\s*-\s*/i, '').trim() || title;
  return title;
}

export function desktopRailCardLabel(card: HistoryCardSummary): string {
  return singleSourceLabel(card) ?? safeHistoryLabel(card.title) ?? card.cardType;
}

export function desktopCardHeaderTitle(card: HistoryCardSummary, zoneName: string | null): string {
  const zone = safeHistoryLabel(zoneName);
  const source = singleSourceLabel(card);
  const title = source
    ? `${source} - ${titleWithoutThemePrefix(card)}`
    : (safeHistoryLabel(card.title) ?? card.cardType);

  if (card.scope !== 'zone' || !zone || title.toLocaleLowerCase().includes(zone.toLocaleLowerCase())) {
    return title;
  }
  return `${title} ${zone}`;
}

export function desktopSourceOptions(card: HistoryCardSummary): DesktopSourceOption[] {
  const hasMultipleSources = sourceCount(card) > 1
    || (card.sourceDevices?.length ?? 0) > 1
    || (card.sourceLabels?.length ?? 0) > 1;
  if (!hasMultipleSources) return [];

  const sources = (card.sourceDevices ?? []).reduce<DesktopSourceOption[]>((options, device) => {
    const key = cleanText(device.sourceKey);
    const label = safeHistoryLabel(device.name);
    if (!key || !label || options.some((option) => option.key === key || option.label === label)) {
      return options;
    }
    options.push({ key, label });
    return options;
  }, []);

  if (sources.length === 0) return [];
  return [{ key: null, label: 'All' }, ...sources];
}

export function selectableDesktopViews(card: HistoryCardSummary): DesktopViewOption[] {
  const definition = historyCardDefinitionsByType[card.cardType];
  const allowedViews = new Set<HistoryViewMode>(definition.views as readonly HistoryViewMode[]);
  const views = card.views.filter((view): view is HistoryViewMode => allowedViews.has(view));
  const resolved = views.length > 0 ? views : [card.defaultView as HistoryViewMode];
  return resolved.map((view) => ({ view, labelKey: `history.viewMode.${view}` }));
}

export function defaultDesktopView(card: HistoryCardSummary): HistoryViewMode {
  const views = selectableDesktopViews(card).map((entry) => entry.view);
  return views.includes(card.defaultView) ? card.defaultView : views[0] ?? card.defaultView;
}

export function desktopBoundsForData(requested: ViewportBounds, dataBounds: ViewportBounds | null): ViewportBounds {
  if (!dataBounds) return requested;
  return {
    minMs: Math.min(requested.minMs, dataBounds.minMs),
    maxMs: Math.max(requested.maxMs, dataBounds.maxMs),
  };
}
