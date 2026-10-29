import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdvancedScheduleDrawer } from '../AdvancedScheduleDrawer';
import deChDevices from '../../../../public/locales/de-CH/devices.json';
import deChValves from '../../../../public/locales/de-CH/valves.json';
import enDevices from '../../../../public/locales/en/devices.json';
import enValves from '../../../../public/locales/en/valves.json';
import esDevices from '../../../../public/locales/es/devices.json';
import frDevices from '../../../../public/locales/fr/devices.json';
import itDevices from '../../../../public/locales/it/devices.json';
import lgDevices from '../../../../public/locales/lg/devices.json';
import ptDevices from '../../../../public/locales/pt/devices.json';
import { dendroAnalyticsAPI, irrigationZonesAPI } from '../../../services/api';
import type { IrrigationZone, ZoneRecommendation } from '../../../types/farming';

vi.mock('../../../services/api', () => ({
  dendroAnalyticsAPI: { getZoneRecommendations: vi.fn().mockReturnValue(new Promise(() => {})) },
  irrigationZonesAPI: {
    updateConfig: vi.fn().mockResolvedValue({}),
    updateSchedule: vi.fn().mockResolvedValue({}),
  },
}));

const zone = {
  id: 42,
  name: 'North Block',
  device_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  schedule: null,
  timezone: 'Europe/Zurich',
} satisfies IrrigationZone;

const devices = { en: enDevices, 'de-CH': deChDevices, es: esDevices, fr: frDevices, it: itDevices, lg: lgDevices, pt: ptDevices } as const;
type Locale = keyof typeof devices;
const de = {
  tabScheduling: 'Erweiterte Planung', tabAnalysis: 'Erweiterte Analyse', noSchedule: 'Kein Zeitplan festgelegt',
  calibration: 'Dendro-Kalibrierung', stressLabel: 'Stress-Auslöseschwelle', baseDuration: 'Basisdauer',
  status: 'Status', weatherControlled: 'Durch Wetterintegration gesteuert', lastTriggered: 'Zuletzt ausgelöst', never: 'Nie', stressMedium: 'Mittel — mässiger Stress (empfohlen)',
  responseProportional: 'Proportional — Dauer an das Stressniveau anpassen', responseFixed: 'Fest — immer die Basisdauer verwenden',
  responseAggressive: 'Aggressiv — bei starkem Stress deutlich verlängern', loading: 'Empfehlungen werden geladen…',
  empty: 'Für diese Zone wurden noch keine Empfehlungen berechnet. Starten Sie die Dendro-Berechnung oder warten Sie auf den täglichen Lauf um 08:00 UTC.',
  unavailable: 'In den Empfehlungsdiagnosen nicht verfügbar', insufficient: 'Nicht genügend Daten', coupled: 'Gekoppelt',
  timezoneError: 'Speichern fehlgeschlagen.', timezoneExample: 'z. B. Europe/Rome', local: '{{start}} – {{end}} Ortszeit',
  twd: 'Die Hüllkurve über ein rollendes Fenster erfasst den maximalen Stammdurchmesser vor Tagesanbruch im Berechnungszeitraum (365 Tage). TWD-night = envelopeRef − d_max. TWD-day = envelopeRef − d_min. Es gelten absolute Schwellen (µm); die artspezifische Kalibrierung erfolgt über den obigen Kalibrierungsschlüssel.',
};

function localeInstance(lng: Locale) {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng, fallbackLng: false, defaultNS: 'devices', ns: ['devices', 'valves'],
    resources: Object.fromEntries(Object.entries(devices).map(([code, bundle]) => [code, {
      devices: bundle,
      valves: code === 'de-CH' ? deChValves : enValves,
    }])),
    interpolation: { escapeValue: false }, react: { useSuspense: false }, initImmediate: false,
  });
  return instance;
}

function renderLocalized(
  zoneValue: IrrigationZone,
  lng: Locale,
  props: { onSaved?: () => void; onClose?: () => void; onEditSchedule?: () => void; onEditPolicy?: () => void } = {},
) {
  const instance = localeInstance(lng);
  const view = render(
    <I18nextProvider i18n={instance}>
      <AdvancedScheduleDrawer
        isOpen zone={zoneValue} onClose={props.onClose ?? vi.fn()}
        onSaved={props.onSaved} onEditSchedule={props.onEditSchedule} onEditPolicy={props.onEditPolicy}
      />
    </I18nextProvider>,
  );
  return { ...view, instance };
}

const drawerKeys = [
  'advancedSchedule.tabScheduling','advancedSchedule.tabAnalysis','advancedSchedule.phenologyDescription',
  'advancedSchedule.stressTriggerLevel','advancedSchedule.stressLevel.low','advancedSchedule.stressLevel.medium',
  'advancedSchedule.stressLevel.high','advancedSchedule.stressLevel.conservative','advancedSchedule.stressLevelOther',
  'advancedSchedule.baseDuration','advancedSchedule.responseModeOption.proportional','advancedSchedule.responseModeOption.fixed',
  'advancedSchedule.responseModeOption.aggressive','advancedSchedule.lastTriggered','advancedSchedule.never',
  'advancedSchedule.status','advancedSchedule.weatherControlled','advancedSchedule.noSchedule',
  'advancedSchedule.rainSuppressionDescription','advancedSchedule.recoveryDescription','advancedSchedule.aggregationDescription',
  'advancedSchedule.timezoneExample','advancedSchedule.timezoneSaveFailed','advancedSchedule.dmaxWindow',
  'advancedSchedule.dminWindow','advancedSchedule.localWindow','advancedSchedule.method',
  'advancedSchedule.stepwiseEnvelope','advancedSchedule.twdDescription','advancedSchedule.baselineR2',
  'advancedSchedule.rolling14DayR2','advancedSchedule.sdVpdStatusLabel','advancedSchedule.sdVpdStatus.coupled',
  'advancedSchedule.sdVpdStatus.decoupled','advancedSchedule.sdVpdStatus.insufficient_data',
  'advancedSchedule.vpdOverrides','advancedSchedule.vpdOverrideCounts','advancedSchedule.sdVpdDescription',
  'advancedSchedule.insufficientData','advancedSchedule.diagnosticsUnavailable','advancedSchedule.loadingRecommendations',
  'advancedSchedule.computedAt','advancedSchedule.usableTrees','advancedSchedule.lowConfidenceTrees',
  'advancedSchedule.outlierFiltered','advancedSchedule.zoneConfidence','advancedSchedule.noRecommendations',
  'advancedSchedule.sectionPhenology','advancedSchedule.sectionScheduleParameters','advancedSchedule.sectionRainSuppression',
  'advancedSchedule.sectionRecoveryVerification','advancedSchedule.sectionZoneAggregation','advancedSchedule.sectionExtractionWindows',
  'advancedSchedule.sectionTwdMethod','advancedSchedule.sectionSdVpdCorrelation','advancedSchedule.sectionLatestReasoningTrace',
  'zoneConfig.dendroCalibration','zoneConfig.calibration.default','zoneConfig.calibration.apple',
  'zoneConfig.calibration.grapevine','zoneConfig.calibration.olive','zoneConfig.timezone','zoneConfig.save','schedule.saved',
] as const;

function recommendation(diagnostics: ZoneRecommendation['diagnostics']): ZoneRecommendation {
  return {
    id: 7, zone_id: 42, date: '2026-10-27', zone_stress_summary: 'moderate', rainfall_mm: null,
    water_delivered_liters: 0, irrigation_action: 'maintain', action_reasoning: 'Backend reasoning remains verbatim.',
    recommendation_json: null, diagnostics, computed_at: '2026-10-27T08:00:00Z', rain_suppression_active: 0,
    recovery_verification_active: 0, vpd_max_kpa: null, vpd_source: null, usable_tree_count: 0,
    low_confidence_tree_count: 0, outlier_filtered_tree_count: 0, zone_confidence_score: 0,
  };
}
const zeroDiagnostics: NonNullable<ZoneRecommendation['diagnostics']> = {
  vpdOverrideSummary: { downgradedTreeCount: 0, upgradedTreeCount: 0 },
  sdVpdSummary: { baselineR2: 0, rolling14dR2: 0, status: 'coupled', comparableTreeCount: 0, decoupledTreeCount: 0 },
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('AdvancedScheduleDrawer', () => {
  it('keeps advanced analysis timezone controls compact', () => {
    renderLocalized(zone, 'en');
    fireEvent.click(screen.getByRole('button', { name: 'Advanced Analysis' }));
    expect(screen.getByText(enDevices.zoneConfig.timezone)).toBeInTheDocument();
    expect(screen.queryByText('IANA timezone (e.g. Europe/Rome). Used to align nightly min/max extraction windows.')).not.toBeInTheDocument();
  });

  it('loads a legacy stage as its FAO-56 stage and saves a cleared stage as default', async () => {
    renderLocalized(zone, 'en', { onClose: vi.fn() });
    const legacyZone = { ...zone, cropType: 'grapevine', phenologicalStage: 'veraison' } as IrrigationZone;
    cleanup(); renderLocalized(legacyZone, 'en');
    const stage = screen.getByDisplayValue('Mid-season (fruit growth, ripening)') as HTMLSelectElement;
    expect(stage.value).toBe('mid_season');
    expect([...stage.options].map((option) => option.value)).toEqual(['', 'initial', 'development', 'mid_season', 'late_season', 'dormancy']);
    fireEvent.change(stage, { target: { value: '' } });
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { phenologicalStage: 'default' }));
  });

  it('gives the stage select an accessible name and HelpTip', () => {
    const stageZone = { ...zone, cropType: 'maize', phenologicalStage: 'late_season' } as IrrigationZone;
    renderLocalized(stageZone, 'en');
    const stage = screen.getByRole('combobox', { name: 'Phenological stage' }) as HTMLSelectElement;
    expect(stage.value).toBe('late_season');
    fireEvent.click(screen.getByRole('button', { name: 'About growth stages' }));
    expect(screen.getByText(/FAO-56 growth stages set the crop coefficient Kc/)).toBeInTheDocument();
  });

  it('mounts German Scheduling copy and preserves schedule identifiers and callbacks', () => {
    const close = vi.fn(); const policy = vi.fn();
    const { container } = renderLocalized(zone, 'de-CH', { onClose: close, onEditPolicy: policy });
    expect(screen.getByRole('button', { name: de.tabScheduling })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.tabAnalysis })).toBeInTheDocument();
    expect(screen.getByText(de.noSchedule)).toBeInTheDocument();
    expect(screen.getByText(de.calibration)).toBeInTheDocument();
    const calibration = [...container.querySelectorAll('select')][1] as HTMLSelectElement;
    expect([...calibration.options].map((option) => option.value)).toEqual(['default', 'apple', 'grapevine', 'olive']);
    expect([...calibration.options].map((option) => option.textContent)).toEqual([
      deChDevices.zoneConfig.calibration.default, deChDevices.zoneConfig.calibration.apple,
      deChDevices.zoneConfig.calibration.grapevine, deChDevices.zoneConfig.calibration.olive,
    ]);
    fireEvent.click(screen.getByRole('button', { name: deChValves.irrigationPolicy.openEditor }));
    fireEvent.click(screen.getByRole('button', { name: '×' }));
    expect(policy).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
    expect(document.body).not.toHaveTextContent(/Advanced Scheduling|Advanced Analysis|No schedule set|advancedSchedule\./);

    cleanup();
    const dendroZone: IrrigationZone = {
      ...zone,
      schedule: { irrigation_zone_id: 42, trigger_metric: 'DENDRO', threshold_kpa: 2, enabled: true, duration_minutes: 20, response_mode: 'proportional' },
    };
    const edit = vi.fn(); const { container: scheduled } = renderLocalized(dendroZone, 'de-CH', { onEditSchedule: edit });
    expect(screen.getByText(de.stressLabel)).toBeInTheDocument(); expect(screen.getByText(de.stressMedium)).toBeInTheDocument();
    expect(screen.getByText(de.baseDuration)).toBeInTheDocument(); expect(screen.getByText(de.status)).toBeInTheDocument();
    expect(screen.getByText(de.weatherControlled)).toBeInTheDocument(); expect(screen.getByText(de.lastTriggered)).toBeInTheDocument(); expect(screen.getByText(de.never)).toBeInTheDocument();
    const response = [...scheduled.querySelectorAll('select')].find((select) => (select as HTMLSelectElement).value === 'proportional')!;
    expect([...response.options].map((option) => option.value)).toEqual(['proportional', 'fixed', 'aggressive']);
    expect([...response.options].map((option) => option.textContent)).toEqual([de.responseProportional, de.responseFixed, de.responseAggressive]);
    expect(document.body).not.toHaveTextContent(/Stress trigger level|Base duration|Proportional — scale with stress level|Last triggered|Never/);
    fireEvent.click(screen.getByRole('button', { name: deChValves.irrigationPreference.editSchedule }));
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('shows an unknown stress threshold and distinct VPD override counts in German', async () => {
    const unknownThresholdZone: IrrigationZone = {
      ...zone,
      schedule: { irrigation_zone_id: 42, trigger_metric: 'DENDRO', threshold_kpa: 5, enabled: true, duration_minutes: 20, response_mode: 'proportional' },
    };
    renderLocalized(unknownThresholdZone, 'de-CH');
    expect(screen.getByText('Stufe 5')).toBeInTheDocument();

    cleanup();
    const unequalCounts: NonNullable<ZoneRecommendation['diagnostics']> = {
      ...zeroDiagnostics,
      vpdOverrideSummary: { downgradedTreeCount: 2, upgradedTreeCount: 1 },
    };
    vi.mocked(dendroAnalyticsAPI.getZoneRecommendations).mockResolvedValueOnce([recommendation(unequalCounts)]);
    renderLocalized(zone, 'de-CH');
    fireEvent.click(screen.getByRole('button', { name: de.tabAnalysis }));
    expect(await screen.findByText('2 herabgestuft / 1 heraufgestuft')).toBeInTheDocument();
  });

  it('keeps conditional policy creation reachable without a legacy schedule', () => {
    const onEditPolicy = vi.fn(); renderLocalized(zone, 'en', { onEditPolicy });
    fireEvent.click(screen.getByRole('button', { name: /configure conditional irrigation/i }));
    expect(onEditPolicy).toHaveBeenCalledTimes(1);
  });

  it('covers loading, empty, zero, null and unknown recommendation diagnostics in German', async () => {
    let resolveRecommendations!: (value: ZoneRecommendation[]) => void;
    vi.mocked(dendroAnalyticsAPI.getZoneRecommendations).mockReturnValueOnce(new Promise<ZoneRecommendation[]>((resolve) => { resolveRecommendations = resolve; }));
    renderLocalized(zone, 'de-CH'); fireEvent.click(screen.getByRole('button', { name: de.tabAnalysis }));
    expect(screen.getByText(de.loading)).toBeInTheDocument(); resolveRecommendations([]);
    expect(await screen.findByText(de.empty)).toBeInTheDocument();
    expect(dendroAnalyticsAPI.getZoneRecommendations).toHaveBeenCalledWith(42, 7);
    expect(document.body).not.toHaveTextContent(/No zone recommendations computed yet|Unavailable in recommendation diagnostics|Baseline R²|Rolling 14-day R²|VPD overrides|Timezone|d_max window|Stepwise envelope|advancedSchedule\./);

    cleanup(); vi.mocked(dendroAnalyticsAPI.getZoneRecommendations).mockResolvedValueOnce([recommendation(zeroDiagnostics)]);
    renderLocalized(zone, 'de-CH'); fireEvent.click(screen.getByRole('button', { name: de.tabAnalysis }));
    expect(await screen.findByText('Backend reasoning remains verbatim.')).toBeInTheDocument();
    expect(screen.getAllByText('0.000')).toHaveLength(2); expect(screen.getByText(de.coupled)).toBeInTheDocument();
    expect(screen.getByText('0 herabgestuft / 0 heraufgestuft')).toBeInTheDocument();
    expect(screen.getAllByText('0')).toHaveLength(3); expect(screen.getByText('0%')).toBeInTheDocument();

    cleanup();
    const nullMetricDiagnostics: NonNullable<ZoneRecommendation['diagnostics']> = {
      ...zeroDiagnostics, sdVpdSummary: { ...zeroDiagnostics.sdVpdSummary, baselineR2: null, rolling14dR2: null, status: 'insufficient_data' },
    };
    vi.mocked(dendroAnalyticsAPI.getZoneRecommendations).mockResolvedValueOnce([recommendation(nullMetricDiagnostics)]);
    renderLocalized(zone, 'de-CH'); fireEvent.click(screen.getByRole('button', { name: de.tabAnalysis }));
    expect(await screen.findAllByText(de.insufficient)).toHaveLength(3); expect(screen.queryByText('0.000')).not.toBeInTheDocument();

    cleanup(); vi.mocked(dendroAnalyticsAPI.getZoneRecommendations).mockResolvedValueOnce([recommendation(null)]);
    renderLocalized(zone, 'de-CH'); fireEvent.click(screen.getByRole('button', { name: de.tabAnalysis }));
    expect(await screen.findAllByText(de.unavailable)).toHaveLength(4);

    cleanup();
    const unknown = { ...zeroDiagnostics, sdVpdSummary: { ...zeroDiagnostics.sdVpdSummary } };
    Reflect.set(unknown.sdVpdSummary, 'status', 'future_backend_status');
    vi.mocked(dendroAnalyticsAPI.getZoneRecommendations).mockResolvedValueOnce([recommendation(unknown)]);
    renderLocalized(zone, 'de-CH'); fireEvent.click(screen.getByRole('button', { name: de.tabAnalysis }));
    await screen.findByText('Backend reasoning remains verbatim.');
    expect(screen.getByText(deChDevices.advancedSchedule.sdVpdStatusLabel).parentElement).toHaveTextContent('—');
  });

  it('localizes timezone failure and success across language changes with unchanged API payloads', async () => {
    const failedCallback = vi.fn(); vi.mocked(irrigationZonesAPI.updateConfig).mockRejectedValueOnce(new Error('offline'));
    const failed = renderLocalized(zone, 'de-CH', { onSaved: failedCallback });
    fireEvent.click(screen.getByRole('button', { name: de.tabAnalysis }));
    fireEvent.change(screen.getByDisplayValue('Europe/Zurich'), { target: { value: 'Europe/Rome' } });
    fireEvent.click(screen.getByRole('button', { name: deChDevices.zoneConfig.save }));
    expect(await screen.findByText(de.timezoneError)).toBeInTheDocument();
    expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { timezone: 'Europe/Rome' }); expect(failedCallback).not.toHaveBeenCalled();
    await failed.instance.changeLanguage('en'); expect(await screen.findByText('Failed to save.')).toBeInTheDocument();

    cleanup(); const savedCallback = vi.fn(); vi.mocked(irrigationZonesAPI.updateConfig).mockResolvedValueOnce(zone);
    const saved = renderLocalized(zone, 'de-CH', { onSaved: savedCallback });
    fireEvent.click(screen.getByRole('button', { name: de.tabAnalysis }));
    fireEvent.change(screen.getByDisplayValue('Europe/Zurich'), { target: { value: 'Europe/Rome' } });
    fireEvent.click(screen.getByRole('button', { name: deChDevices.zoneConfig.save }));
    expect(await screen.findByText(deChDevices.schedule.saved)).toBeInTheDocument();
    expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { timezone: 'Europe/Rome' }); expect(savedCallback).toHaveBeenCalledTimes(1);
    await saved.instance.changeLanguage('en'); expect(await screen.findByText(enDevices.schedule.saved)).toBeInTheDocument();
  });

  it('keeps extraction endpoints and technical notation and resolves locale keys without fallback', () => {
    renderLocalized(zone, 'de-CH'); fireEvent.click(screen.getByRole('button', { name: de.tabAnalysis }));
    expect(screen.getByText(de.local.replace('{{start}}', '23:00').replace('{{end}}', '07:00'))).toBeInTheDocument();
    expect(screen.getByText(de.local.replace('{{start}}', '10:00').replace('{{end}}', '16:00'))).toBeInTheDocument();
    const twd = screen.getByText(de.twd); for (const token of ['365', 'TWD-night', 'TWD-day', 'envelopeRef', 'd_max', 'd_min', 'µm']) expect(twd).toHaveTextContent(token);
    for (const lng of Object.keys(devices) as Locale[]) {
      const instance = localeInstance(lng);
      for (const key of drawerKeys) {
        const value = String(instance.t(key, { level: 3, start: '23:00', end: '07:00', downgraded: 2, upgraded: 1 } as never));
        expect(value, `${lng}:${key}`).toEqual(expect.any(String)); expect(value.trim()).not.toBe('');
        expect(value).not.toBe(key); expect(value).not.toMatch(/\{\{[^}]+\}\}/);
      }
    }
  });
});
