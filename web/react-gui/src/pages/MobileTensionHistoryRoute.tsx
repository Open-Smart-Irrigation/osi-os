import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  HistoryAuthError,
  MobileTensionHistory,
  type HistoryContext,
  type HistoryWindowRequest,
  type MobileHistoryDiagnostics,
} from '@osi/history-uplot';
import { useAuth } from '../contexts/AuthContext';
import { serializeSessionIdentity } from '../services/authSession';
import { irrigationZonesAPI } from '../services/api';
import type { IrrigationZone } from '../types/farming';
import { createMobileAnalysisLoader } from '../history/mobileAnalysisHistoryAdapter';
import { useMobileTensionCatalog } from '../history/useMobileTensionCatalog';
import { mobileTensionLabels } from '../history/mobileTensionLabels';
import {
  MOBILE_HISTORY_INTERNAL_DIAGNOSTICS_ENABLED,
  MOBILE_HISTORY_INTERNAL_ENABLED,
} from '../history/mobileHistoryInternalGate';

export function parseMobileHistoryZoneId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function usableTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

function routeMessage(message: string) {
  return <div className="min-h-[12rem] p-6 text-[var(--text)]">{message}</div>;
}

export function MobileTensionHistoryRoute() {
  const { zoneId: zoneIdParam } = useParams<{ zoneId: string }>();
  const { t, i18n } = useTranslation('history');
  const { sessionIdentity, logout } = useAuth();
  const zoneId = parseMobileHistoryZoneId(zoneIdParam);
  const sessionKey = serializeSessionIdentity(sessionIdentity);
  const [retry, setRetry] = useState(0);
  const [zoneState, setZoneState] = useState<{
    loading: boolean;
    zones: IrrigationZone[];
    failed: boolean;
  }>({ loading: true, zones: [], failed: false });
  const [diagnostics, setDiagnostics] = useState<MobileHistoryDiagnostics | null>(null);
  const diagnosticsEnabled = MOBILE_HISTORY_INTERNAL_ENABLED && MOBILE_HISTORY_INTERNAL_DIAGNOSTICS_ENABLED;

  useEffect(() => {
    if (!MOBILE_HISTORY_INTERNAL_ENABLED || zoneId === null) return;
    let active = true;
    setZoneState({ loading: true, zones: [], failed: false });
    void irrigationZonesAPI.getAll().then((zones) => {
      if (active) setZoneState({ loading: false, zones, failed: false });
    }).catch(() => {
      if (active) setZoneState({ loading: false, zones: [], failed: true });
    });
    return () => {
      active = false;
    };
  }, [retry, zoneId]);

  const zone = zoneId === null ? undefined : zoneState.zones.find((candidate) => candidate.id === zoneId);
  const timeZone = usableTimeZone(zone?.timezone);
  const zoneReady = zoneState.zones.length > 0 && zone !== undefined;
  const enabled = MOBILE_HISTORY_INTERNAL_ENABLED && zoneReady && timeZone !== null && sessionKey !== '';
  const catalog = useMobileTensionCatalog({ enabled, zoneId: String(zoneId ?? ''), sessionKey });
  const loader = useMemo(() => createMobileAnalysisLoader(), []);
  const labels = useMemo(() => mobileTensionLabels(t), [t]);
  const context = useMemo<HistoryContext>(() => ({
    sessionKey,
    scopeKey: `zone:${zoneId ?? ''}`,
    cardId: 'mobile-water-tension',
  }), [sessionKey, zoneId]);
  const readPolicy = useCallback((_request: HistoryWindowRequest) => 'edge-hourly' as const, []);
  const registerDiagnostics = useCallback((next: MobileHistoryDiagnostics | null) => {
    setDiagnostics(next);
  }, []);

  useEffect(() => {
    if (!diagnosticsEnabled || diagnostics === null) return;
    const owner = diagnostics;
    window.__osiMobileHistoryDiagnostics = owner;
    return () => {
      if (window.__osiMobileHistoryDiagnostics === owner) delete window.__osiMobileHistoryDiagnostics;
    };
  }, [diagnostics, diagnosticsEnabled]);

  useEffect(() => {
    if (catalog.error instanceof HistoryAuthError && catalog.error.status === 401) logout();
  }, [catalog.error, logout]);

  if (!MOBILE_HISTORY_INTERNAL_ENABLED || zoneId === null) return <Navigate to="/history" replace />;
  if (zoneState.loading) return routeMessage(t('history.mobileTension.route.zoneLoading'));
  if (zoneState.failed) {
    return (
      <div className="min-h-[12rem] p-6 text-[var(--text)]">
        <p>{t('history.mobileTension.route.zonesFailed')}</p>
        <button type="button" onClick={() => setRetry((value) => value + 1)}>{t('history.mobileTension.retry')}</button>
      </div>
    );
  }
  if (!zoneReady) return <Navigate to="/history" replace />;
  if (timeZone === null) return routeMessage(t('history.mobileTension.route.timeZoneUnavailable'));
  if (catalog.error instanceof HistoryAuthError && catalog.error.status === 401) return null;
  if (catalog.error instanceof HistoryAuthError && catalog.error.status === 403) return routeMessage(t('history.mobileTension.accessDenied'));

  return (
    <Suspense fallback={routeMessage(t('history.mobileTension.route.zoneLoading'))}>
      <MobileTensionHistory
        sources={catalog.sources}
        defaultSelectedIds={catalog.defaultSelectedIds}
        catalogError={catalog.error}
        catalogLoading={catalog.isLoading}
        context={context}
        readPolicy={readPolicy}
        locale={i18n.resolvedLanguage ?? i18n.language}
        timeZone={timeZone}
        zoneLabel={zone.name}
        labels={labels}
        load={loader}
        refreshCatalogForGeneration={catalog.refreshForGeneration}
        onAuthError={(error) => {
          if (error instanceof HistoryAuthError && error.status === 401) logout();
        }}
        registerInternalDiagnostics={diagnosticsEnabled ? registerDiagnostics : undefined}
      />
    </Suspense>
  );
}
