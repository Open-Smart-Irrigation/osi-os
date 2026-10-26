export interface MobileSoilUplotGateInput {
  buildFlag?: string;
  historyUxReady: boolean;
  historyUxEnabled: boolean;
  isMobile: boolean;
  cardType: string | null | undefined;
}

export function isMobileSoilUplotEnabled({
  buildFlag = typeof import.meta.env === 'undefined' ? undefined : import.meta.env.VITE_HISTORY_UPLOT_SOIL_ENABLED,
  historyUxReady,
  historyUxEnabled,
  isMobile,
  cardType,
}: MobileSoilUplotGateInput): boolean {
  return buildFlag === 'true'
    && historyUxReady
    && historyUxEnabled
    && isMobile
    && cardType === 'soil';
}

export function mobileSoilHistoryContextKey(sessionEpoch: number, principalId: string | null, scopeKey: string, cardId: string, sourceKey?: string | null): string {
  return `${sessionEpoch}:${principalId ?? 'anonymous'}:${scopeKey}:${cardId}:${sourceKey ?? ''}`;
}
