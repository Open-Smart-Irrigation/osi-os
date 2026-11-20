export interface MobileSoilUplotGateInput {
  buildEnabled: boolean;
  historyUxReady: boolean;
  historyUxEnabled: boolean;
  isMobile: boolean;
  cardType: string | null | undefined;
}

export function isMobileSoilUplotEnabled({
  buildEnabled,
  historyUxReady,
  historyUxEnabled,
  isMobile,
  cardType,
}: MobileSoilUplotGateInput): boolean {
  return buildEnabled
    && historyUxReady
    && historyUxEnabled
    && isMobile
    && cardType === 'soil';
}

export function mobileSoilHistoryContextKey(sessionEpoch: number, principalId: string | null, scopeKey: string, cardId: string, sourceKey?: string | null): string {
  return `${sessionEpoch}:${principalId ?? 'anonymous'}:${scopeKey}:${cardId}:${sourceKey ?? ''}`;
}
