import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { HistoryDesktopShell } from '../components/history/HistoryDesktopShell';
import { HistoryMobileShell } from '../components/history/HistoryMobileShell';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../history/useFeatureFlags';
import { useHistoryCards } from '../history/useHistoryCards';
import { irrigationZonesAPI } from '../services/api';
import type { IrrigationZone } from '../types/farming';

const zonesFetcher = () => irrigationZonesAPI.getAll();

export const HistoryDashboard: React.FC = () => {
  const { username, logout } = useAuth();
  const featureFlags = useFeatureFlags();
  const [selectedZoneId, setSelectedZoneId] = useState<number | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

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

  const availableZones = zones ?? [];
  const shellReady = featureFlags.historyEnabled && availableZones.length > 0 && !zonesError;
  const loadingMessage = featureFlags.historyEnabled && (zonesLoading || cardsLoading)
    ? 'Loading local history cards...'
    : null;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <header className="bg-[var(--header-bg)] shadow-xl">
        <div className="mx-auto max-w-7xl px-4 py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-4xl font-bold text-[var(--header-text)] high-contrast-text">
                History
              </h1>
              <p className="mt-1 text-lg text-[var(--header-subtext)]">
                Local gateway history for {username}
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
                Legacy dashboard
              </Link>
              <button
                type="button"
                onClick={logout}
                className="rounded-lg bg-[var(--secondary-bg)] px-6 py-3 text-lg font-bold text-[var(--text)] transition-colors hover:bg-[var(--border)]"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8">
        {!featureFlags.historyEnabled && (
          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6">
            <h2 className="text-2xl font-bold text-[var(--text)]">History is unavailable</h2>
            <p className="mt-2 max-w-2xl text-[var(--text-tertiary)]">
              Runtime feature flags keep the new history shell off until the local gateway enables it.
            </p>
            {featureFlags.error && (
              <div className="mt-4">
                <p className="text-sm text-[var(--text-tertiary)]">
                  The feature flag request failed. The legacy dashboard is still available.
                </p>
                <button
                  type="button"
                  onClick={featureFlags.retry}
                  className="mt-3 rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-bold text-white hover:bg-[var(--primary-hover)]"
                >
                  Retry
                </button>
              </div>
            )}
          </section>
        )}

        {featureFlags.historyEnabled && zonesError && (
          <section className="rounded-lg border border-[var(--error-bg)] bg-[var(--surface)] p-6">
            <h2 className="text-2xl font-bold text-[var(--text)]">History zones failed to load</h2>
            <p className="mt-2 text-sm text-[var(--text-tertiary)]">
              {zonesError instanceof Error ? zonesError.message : String(zonesError)}
            </p>
          </section>
        )}

        {featureFlags.historyEnabled && !zonesError && availableZones.length === 0 && !zonesLoading && (
          <section className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-6 text-center">
            <h2 className="text-xl font-bold text-[var(--text)]">No zones yet</h2>
            <p className="mt-2 text-sm text-[var(--text-tertiary)]">
              Create an irrigation zone from the legacy dashboard before opening thematic history.
            </p>
          </section>
        )}

        {loadingMessage && (
          <p className="mb-4 text-sm font-semibold text-[var(--text-tertiary)]">{loadingMessage}</p>
        )}

        {cardsError && (
          <section className="mb-4 rounded-lg border border-[var(--error-bg)] bg-[var(--surface)] p-4">
            <p className="text-sm font-semibold text-[var(--text)]">History cards failed to load.</p>
            <button
              type="button"
              onClick={refreshCards}
              className="mt-3 rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-bold text-white hover:bg-[var(--primary-hover)]"
            >
              Retry cards
            </button>
          </section>
        )}

        {shellReady && (
          <>
            <HistoryMobileShell
              zones={availableZones}
              selectedZoneId={selectedZoneId}
              onSelectZone={setSelectedZoneId}
              cards={cards}
              selectedCard={selectedCard}
              onSelectCard={setSelectedCardId}
            />
            <HistoryDesktopShell
              zones={availableZones}
              selectedZoneId={selectedZoneId}
              onSelectZone={setSelectedZoneId}
              cards={cards}
              selectedCard={selectedCard}
              onSelectCard={setSelectedCardId}
            />
          </>
        )}
      </main>
    </div>
  );
};
