import React, { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { HistoryCardFrame } from '../components/history/HistoryCardFrame';
import { HistoryDetailHeader } from '../components/history/mobile/HistoryDetailHeader';
import { useFeatureFlags } from '../history/useFeatureFlags';
import { useHistoryCards } from '../history/useHistoryCards';
import { historyAPI, irrigationZonesAPI } from '../services/api';
import type { HistoryCardDataScope } from '../history/useHistoryCardData';
import type { HistoryCardSummary, HistoryCardSummaryResponse } from '../history/types';
import type { IrrigationZone } from '../types/farming';

const zonesFetcher = () => irrigationZonesAPI.getAll();

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function decodeRouteCardId(rawCardId: string | undefined): string | null {
  if (!rawCardId) return null;
  try {
    return decodeURIComponent(rawCardId);
  } catch {
    return null;
  }
}

function gatewayEuiForCard(card: HistoryCardSummary): string | null {
  const gatewayEui = card.metadata.gatewayDeviceEui ?? card.metadata.gateway_device_eui ?? card.metadata.gatewayEui;
  return typeof gatewayEui === 'string' && gatewayEui.trim() ? gatewayEui : null;
}

function containsRawGatewayIdentifier(value: string | null | undefined, gatewayEui: string): boolean {
  if (!value) return false;
  const normalizedValue = value.toUpperCase();
  return normalizedValue.includes(gatewayEui.toUpperCase()) || /\b[A-F0-9]{16}\b/i.test(value);
}

function safeGatewayText(value: string | null | undefined, gatewayEui: string): string | null {
  if (!value || containsRawGatewayIdentifier(value, gatewayEui)) return null;
  return value;
}

function sanitizeGatewayRouteCard(
  t: HistoryTranslate,
  card: HistoryCardSummary,
  gatewayEui: string,
): HistoryCardSummary {
  return {
    ...card,
    title: safeGatewayText(card.title, gatewayEui) ?? t('history.cardType.gateway'),
    subtitle: safeGatewayText(card.subtitle, gatewayEui) ?? '',
    sourceLabel: safeGatewayText(card.sourceLabel, gatewayEui),
    sourceLabels: card.sourceLabels?.filter((label) => !containsRawGatewayIdentifier(label, gatewayEui)),
    sourceDevices: card.sourceDevices?.map((device) => ({
      ...device,
      name: safeGatewayText(device.name, gatewayEui),
    })),
  };
}

type DetailRouteScope =
  | { type: 'zone'; zoneId: number }
  | { type: 'gateway'; gatewayEui: string };

function scopeForCard(card: HistoryCardSummary, routeScope: DetailRouteScope): HistoryCardDataScope | null {
  if (routeScope.type === 'gateway') {
    return { type: 'gateway', gatewayEui: routeScope.gatewayEui };
  }

  if (card.scope === 'gateway') {
    const gatewayEui = gatewayEuiForCard(card);
    return gatewayEui ? { type: 'gateway', gatewayEui } : null;
  }
  return { type: 'zone', zoneId: routeScope.zoneId };
}

const HistoryDetailError: React.FC<{
  title: string;
  body: string;
  backLabel: string;
}> = ({ title, body, backLabel }) => (
  <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
    <section className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
      <h1 className="text-2xl font-bold text-[var(--text)]">{title}</h1>
      <p className="mt-2 text-sm text-[var(--text-tertiary)]">{body}</p>
      <Link
        to="/history"
        className="mt-5 inline-flex rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-bold text-white"
      >
        {backLabel}
      </Link>
    </section>
  </div>
);

export const HistoryCardDetailPage: React.FC = () => {
  const { zoneId: rawZoneId, gatewayEui: rawGatewayEui, cardId: rawCardId } = useParams();
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const featureFlags = useFeatureFlags();
  const zoneId = Number(rawZoneId);
  const gatewayEui = typeof rawGatewayEui === 'string' && rawGatewayEui.trim() ? rawGatewayEui : null;
  const cardId = decodeRouteCardId(rawCardId);
  const validZoneRoute = Number.isInteger(zoneId) && zoneId > 0 && Boolean(cardId);
  const validGatewayRoute = Boolean(gatewayEui && cardId);
  const validRoute = validZoneRoute || validGatewayRoute;
  const routeScope = useMemo<DetailRouteScope | null>(() => {
    if (validGatewayRoute && gatewayEui) return { type: 'gateway', gatewayEui };
    if (validZoneRoute) return { type: 'zone', zoneId };
    return null;
  }, [gatewayEui, validGatewayRoute, validZoneRoute, zoneId]);

  const {
    data: zones,
    error: zonesError,
    isLoading: zonesLoading,
  } = useSWR<IrrigationZone[]>(
    featureFlags.historyEnabled && routeScope?.type === 'zone' ? '/api/irrigation-zones' : null,
    zonesFetcher,
    { revalidateOnFocus: true },
  );

  const {
    cards,
    error: cardsError,
    isLoading: cardsLoading,
  } = useHistoryCards(routeScope?.type === 'zone' ? routeScope.zoneId : null, featureFlags.historyEnabled);
  const {
    data: gatewayCardsResponse,
    error: gatewayCardsError,
    isLoading: gatewayCardsLoading,
  } = useSWR<HistoryCardSummaryResponse>(
    featureFlags.historyEnabled && routeScope?.type === 'gateway'
      ? `/api/history/gateways/${routeScope.gatewayEui}/cards`
      : null,
    () => {
      if (routeScope?.type !== 'gateway') throw new Error('Gateway route unavailable');
      return historyAPI.getGatewayCards(routeScope.gatewayEui);
    },
    { revalidateOnFocus: true },
  );
  const routeCards = routeScope?.type === 'gateway' ? gatewayCardsResponse?.cards ?? [] : cards;

  const resolvedZone = useMemo(
    () => (routeScope?.type === 'zone' ? (zones ?? []).find((zone) => zone.id === routeScope.zoneId) ?? null : null),
    [routeScope, zones],
  );
  const resolvedCard = useMemo(
    () => routeCards.find((card) => card.cardId === cardId) ?? null,
    [cardId, routeCards],
  );
  const resolvedScope = resolvedCard && routeScope ? scopeForCard(resolvedCard, routeScope) : null;
  const displayCard = useMemo(
    () => (
      resolvedCard && routeScope?.type === 'gateway'
        ? sanitizeGatewayRouteCard(t, resolvedCard, routeScope.gatewayEui)
        : resolvedCard
    ),
    [resolvedCard, routeScope, t],
  );

  useEffect(() => {
    if (!featureFlags.historyEnabled || routeScope?.type !== 'zone' || !resolvedCard || !cardId) return;
    historyAPI.markZoneCardOpened(routeScope.zoneId, cardId).catch(() => undefined);
  }, [cardId, featureFlags.historyEnabled, resolvedCard, routeScope]);

  if (!validRoute) {
    return (
      <HistoryDetailError
        title={t('history.detail.invalidRouteTitle')}
        body={t('history.detail.invalidRouteBody')}
        backLabel={t('history.detail.backToHistory')}
      />
    );
  }

  if (featureFlags.isLoading || zonesLoading || cardsLoading || gatewayCardsLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
        <p className="text-sm font-semibold text-[var(--text-tertiary)]">
          {t('history.detail.loading')}
        </p>
      </div>
    );
  }

  if (
    !featureFlags.historyEnabled
    || zonesError
    || cardsError
    || gatewayCardsError
    || (routeScope?.type === 'zone' && !resolvedZone)
    || !displayCard
    || !resolvedScope
  ) {
    return (
      <HistoryDetailError
        title={t('history.detail.notFoundTitle')}
        body={t('history.detail.notFoundBody')}
        backLabel={t('history.detail.backToHistory')}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <HistoryDetailHeader
        zoneName={resolvedZone?.name ?? null}
        card={displayCard}
        backHref="/history"
      />
      <main className="flex min-h-[calc(100vh-4rem)] flex-col gap-4 px-4 py-4">
        <section className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm font-semibold text-[var(--text-tertiary)]">
          {t('history.detail.controlsPlaceholder')}
        </section>
        <div className="flex-1">
          <HistoryCardFrame card={displayCard} scope={resolvedScope} />
        </div>
        <section className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm font-semibold text-[var(--text-tertiary)]">
          {t('history.detail.inspectorPlaceholder')}
        </section>
      </main>
    </div>
  );
};
