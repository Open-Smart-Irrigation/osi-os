import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Device, Sdi12Profile, SentekChannelSensor, SentekSensorType, TensiomarkChannelLayout, TensiomarkChannelSensor } from '../../types/farming';
import {
  devicesAPI,
  fetchSdi12Profiles,
  getApiErrorMessage,
  postSdi12Identify,
  postSdi12RecipeApply,
  postSdi12RecipeRollback,
  putSdi12Config,
} from '../../services/api';
import type { Sdi12ConfigRequest } from '../../services/api';

interface Sdi12SettingsModalProps {
  device: Device;
  onClose: () => void;
  onUpdate: () => void;
}

// Larger than the device's slowest plausible TX interval. Past this age, a
// pending_identify device is presented as "no response" instead of spinning
// forever -- client-derived only, no DB status change (see A4 plan note: the
// devices.sdi12_probe_status CHECK constraint has no such value).
const SDI12_IDENTIFY_TIMEOUT_MINUTES = 15;

function depthSlots(profile: Sdi12Profile): number[] {
  if (profile.depthSlots?.length) return profile.depthSlots;
  const slots = new Set<number>();
  profile.channels.forEach((channel) => {
    const match = channel.match(/_(\d+)$/);
    if (match) slots.add(Number(match[1]));
  });
  if (slots.size === 0) {
    (profile.defaultDepthsCm ?? []).forEach((_, index) => slots.add(index + 1));
  }
  return Array.from(slots).sort((left, right) => left - right);
}

function depthInputsFor(profile: Sdi12Profile, device: Device): Record<string, string> {
  const stored = device.soil_moisture_probe_depths_json ?? {};
  return Object.fromEntries(depthSlots(profile).map((slot) => {
    const channel = profile.channels.find((candidate) => candidate.endsWith(`_${slot}`));
    const storedValue = channel ? stored[channel] : undefined;
    const defaultValue = profile.defaultDepthsCm?.[slot - 1];
    const value = storedValue != null && Number.isFinite(Number(storedValue))
      ? storedValue
      : defaultValue;
    return [String(slot), value == null ? '' : String(value)];
  }));
}

function pendingMinutes(updatedAt: string | null | undefined): number | null {
  if (!updatedAt) return null;
  const timestamp = new Date(updatedAt).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
}

function pendingAgeLabel(minutes: number | null): string {
  if (minutes == null) return 'Identification pending.';
  return `Identification pending for ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

function canonicalSentekLayout(address: string, sensors: SentekChannelSensor[]): string | null {
  if (!/^[0-9A-Za-z]$/.test(address) || sensors.length < 1 || sensors.length > 10) return null;
  const channels = new Set<number>();
  const positions = new Set<number>();
  const depths = new Set<number>();
  for (const sensor of sensors) {
    if (!Number.isInteger(sensor.channel) || sensor.channel < 1 || sensor.channel > 10 || channels.has(sensor.channel)
      || !Number.isInteger(sensor.response_position) || sensor.response_position < 1 || sensor.response_position > sensors.length || positions.has(sensor.response_position)
      || !Number.isInteger(sensor.depth_cm) || sensor.depth_cm < 1 || sensor.depth_cm > 1000 || depths.has(sensor.depth_cm)
      || (sensor.type !== 'ENVIROSCAN' && sensor.type !== 'TRISCAN')) return null;
    channels.add(sensor.channel);
    positions.add(sensor.response_position);
    depths.add(sensor.depth_cm);
  }
  return JSON.stringify({ version: 1, address, sensors: [...sensors].sort((left, right) => left.response_position - right.response_position) });
}

function canonicalStoredSentekLayout(device: Device): string | null {
  const layout = device.sdi12_channel_layout_json;
  return layout && !('kind' in layout) ? canonicalSentekLayout(layout.address, layout.sensors) : null;
}

function storedSentekLayout(device: Device) {
  const layout = device.sdi12_channel_layout_json;
  return layout && !('kind' in layout) ? layout : null;
}

function storedTensiomarkLayout(device: Device): TensiomarkChannelLayout | null {
  const layout = device.sdi12_channel_layout_json;
  return layout && 'kind' in layout && layout.kind === 'tensiomark' ? layout : null;
}

function blankTensiomarkSensor(channel: 1 | 2): TensiomarkChannelSensor {
  return { address: '', channel, identity: '', depth_cm: null, calibration_range: 'unverified' };
}

// Identify stores the raw `aI!` reply. When it is a Tensiomark identity, it
// prefills the first sensor's address and identity; otherwise a discovered
// address prefills the address alone.
function initialTensiomarkSensor(device: Device): TensiomarkChannelSensor {
  const sensor = blankTensiomarkSensor(1);
  const identity = typeof device.sdi12_identity === 'string' ? device.sdi12_identity.trim() : '';
  const match = /^([0-9A-Za-z])11TENSIOMARK_2Vh_10A\d{5}$/.exec(identity);
  if (match) return { ...sensor, address: match[1], identity };
  return { ...sensor, address: normalizedDiscoveredSdi12Address(device.sdi12_discovered_address) ?? '' };
}

type TensiomarkLayoutError =
  | 'sensorCount' | 'addressInvalid' | 'channelInvalid' | 'identityInvalid' | 'depthInvalid'
  | 'calibrationInvalid' | 'duplicateAddress' | 'duplicateIdentity' | 'duplicateChannel';

type TensiomarkLayoutResult =
  | { ok: true; layout: TensiomarkChannelLayout }
  | { ok: false; error: TensiomarkLayoutError; row: number; address?: string; channel?: number };

// Mirrors the backend validator (osi-sdi12-normalize/tensiomark-live.js) and
// names the first failing row (1-based) and field.
function validateTensiomarkLayout(sensors: TensiomarkChannelSensor[]): TensiomarkLayoutResult {
  if (sensors.length < 1 || sensors.length > 2) return { ok: false, error: 'sensorCount', row: 0 };
  const addresses = new Set<string>();
  const identities = new Set<string>();
  const channels = new Set<number>();
  for (const [index, sensor] of sensors.entries()) {
    const row = index + 1;
    if (!/^[0-9A-Za-z]$/.test(sensor.address)) return { ok: false, error: 'addressInvalid', row };
    if (addresses.has(sensor.address)) return { ok: false, error: 'duplicateAddress', row, address: sensor.address };
    if (sensor.channel !== 1 && sensor.channel !== 2) return { ok: false, error: 'channelInvalid', row };
    if (channels.has(sensor.channel)) return { ok: false, error: 'duplicateChannel', row, channel: sensor.channel };
    if (!new RegExp(`^${sensor.address}11TENSIOMARK_2Vh_10A\\d{5}$`).test(sensor.identity)) {
      return { ok: false, error: 'identityInvalid', row, address: sensor.address };
    }
    if (identities.has(sensor.identity)) return { ok: false, error: 'duplicateIdentity', row };
    if (sensor.depth_cm !== null && (!Number.isInteger(sensor.depth_cm) || sensor.depth_cm < 1 || sensor.depth_cm > 1000)) {
      return { ok: false, error: 'depthInvalid', row };
    }
    if (sensor.calibration_range !== 'unverified') return { ok: false, error: 'calibrationInvalid', row };
    addresses.add(sensor.address);
    identities.add(sensor.identity);
    channels.add(sensor.channel);
  }
  return {
    ok: true,
    layout: {
      version: 1,
      kind: 'tensiomark',
      source_unit: 'pF',
      field_order: 'temperature_pf',
      qualification: 'bench_observed',
      sensors: [...sensors].sort((left, right) => left.channel - right.channel),
    },
  };
}

function normalizedDiscoveredSdi12Address(address: string | null | undefined): string | null {
  return typeof address === 'string' && /^[0-9A-Za-z]$/.test(address) ? address : null;
}

export const Sdi12SettingsModal: React.FC<Sdi12SettingsModalProps> = ({
  device,
  onClose,
  onUpdate,
}) => {
  const { t } = useTranslation('devices');
  const [profiles, setProfiles] = useState<Sdi12Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState(device.sdi12_probe_profile ?? '');
  const [depthInputs, setDepthInputs] = useState<Record<string, string>>({});
  const [initialDepthInputs, setInitialDepthInputs] = useState<Record<string, string>>({});
  const [valueCountInput, setValueCountInput] = useState('');
  const [sentekAddress, setSentekAddress] = useState(
    storedSentekLayout(device)?.address ?? normalizedDiscoveredSdi12Address(device.sdi12_discovered_address) ?? '',
  );
  const [sentekAddressTouched, setSentekAddressTouched] = useState(false);
  const [sentekSensors, setSentekSensors] = useState<SentekChannelSensor[]>(() => {
    const layout = storedSentekLayout(device);
    if (layout?.sensors.length) return layout.sensors;
    const count = Math.max(1, Math.min(8, device.sdi12_value_count ?? 1));
    return Array.from({ length: count }, (_, index) => ({
      channel: index + 1,
      response_position: index + 1,
      depth_cm: device.soil_moisture_probe_depths_json?.[`vwc_${index + 1}`] ?? (index + 1) * 10,
      type: 'ENVIROSCAN' as const,
    }));
  });
  const [tensiomarkSensors, setTensiomarkSensors] = useState<TensiomarkChannelSensor[]>(() => (
    storedTensiomarkLayout(device)?.sensors ?? [initialTensiomarkSensor(device)]
  ));
  const [tensiomarkConfirmed, setTensiomarkConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'identify' | 'save' | 'apply' | 'rollback' | null>(null);
  const [showApplyConfirm, setShowApplyConfirm] = useState(false);
  const [confirmedLayout, setConfirmedLayout] = useState(() => canonicalStoredSentekLayout(device));
  const [identifyPending, setIdentifyPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSdi12Profiles()
      .then((response) => {
        if (cancelled) return;
        setProfiles(response.profiles);
        setSelectedProfileId((current) => (
          current || device.sdi12_probe_profile || response.profiles[0]?.id || ''
        ));
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load SDI-12 probe profiles.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [device.sdi12_probe_profile]);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );

  useEffect(() => {
    if (selectedProfile) {
      const nextDepthInputs = depthInputsFor(selectedProfile, device);
      setDepthInputs(nextDepthInputs);
      setInitialDepthInputs(nextDepthInputs);
      setValueCountInput(device.sdi12_value_count != null ? String(device.sdi12_value_count) : '');
    }
  }, [device, selectedProfile]);

  useEffect(() => {
    setConfirmedLayout(canonicalStoredSentekLayout(device));
  }, [device]);

  useEffect(() => {
    const discoveredAddress = normalizedDiscoveredSdi12Address(device.sdi12_discovered_address);
    if (!sentekAddressTouched && sentekAddress === '' && !storedSentekLayout(device) && discoveredAddress) {
      setSentekAddress(discoveredAddress);
    }
  }, [device, sentekAddress, sentekAddressTouched]);

  // Variable-count profiles have no fixed expectedValues -- this is the same
  // set the edge normalizer treats as learnable (SENTEK_ENVIROSCAN,
  // DELTAT_PR2_4, DELTAT_PR2_6, and the pre-existing GENERIC_VWC escape
  // hatch). Fixed-shape profiles like HYDRASCOUT/TENSIOMARK/IMKO_PICO64
  // never show this field.
  const isVariableCountProfile = selectedProfile ? selectedProfile.expectedValues == null : false;
  const isSentekProfile = selectedProfileId === 'SENTEK_ENVIROSCAN';
  const isTensiomarkProfile = selectedProfileId === 'TENSIOMARK';

  const handleProfileChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedProfileId(event.target.value);
    setTensiomarkConfirmed(false);
    setError(null);
    setInfo(null);
  };

  const handleSave = async () => {
    if (!selectedProfile) {
      setError('Select a probe profile.');
      return;
    }
    if (isTensiomarkProfile) {
      if (!tensiomarkConfirmed) {
        setError(t('sdi12.tensiomark.confirmRequired'));
        return;
      }
      const validation = validateTensiomarkLayout(tensiomarkSensors);
      if (!validation.ok) {
        setError(t(`sdi12.tensiomark.errors.${validation.error}`, {
          row: validation.row, address: validation.address ?? '', channel: validation.channel ?? '',
        }));
        return;
      }
      const layout = validation.layout;
      setBusy('save');
      setError(null);
      setInfo(null);
      try {
        await putSdi12Config(device.deveui, { probe_profile: 'TENSIOMARK', tensiomark_layout: layout });
        setInfo(t('sdi12.tensiomark.saved'));
        onUpdate();
      } catch (err: unknown) {
        setError(getApiErrorMessage(err, 'Failed to save SDI-12 configuration.'));
      } finally {
        setBusy(null);
      }
      return;
    }
    if (isSentekProfile) {
      if (!/^[0-9A-Za-z]$/.test(sentekAddress)) {
        setError('SDI-12 address must be one letter or digit.');
        return;
      }
      if (sentekSensors.length < 1 || sentekSensors.length > 10) {
        setError('Configure between one and ten connected modules.');
        return;
      }
      const savedLayout = canonicalSentekLayout(sentekAddress, sentekSensors);
      if (!savedLayout) {
        setError('Channels, response positions, and positive depths must be unique and valid.');
        return;
      }
      setBusy('save');
      setError(null);
      setInfo(null);
      try {
        await putSdi12Config(device.deveui, {
          probe_profile: selectedProfile.id,
          address: sentekAddress,
          sensors: sentekSensors,
        });
        setInfo(t('sdi12.layoutSaved'));
        setConfirmedLayout(null);
        try {
          const refreshed = await devicesAPI.getAll();
          const refreshedDevice = refreshed.find((candidate) => candidate.deveui === device.deveui);
          if (refreshedDevice && canonicalStoredSentekLayout(refreshedDevice) === savedLayout) {
            setConfirmedLayout(savedLayout);
          }
        } catch {
          setError(t('sdi12.refreshRequired'));
        }
        onUpdate();
      } catch (err: unknown) {
        setError(getApiErrorMessage(err, 'Failed to save SDI-12 configuration.'));
      } finally {
        setBusy(null);
      }
      return;
    }
    const depths: Record<string, number> = {};
    for (const slot of depthSlots(selectedProfile)) {
      const raw = depthInputs[String(slot)]?.trim() ?? '';
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 500) {
        setError('Depths must be whole centimeters between 0 and 500.');
        return;
      }
      depths[String(slot)] = value;
    }
    const depthsChanged = depthSlots(selectedProfile).some((slot) => (
      (depthInputs[String(slot)] ?? '') !== (initialDepthInputs[String(slot)] ?? '')
    ));

    let valueCount: number | null = null;
    if (isVariableCountProfile) {
      const rawValueCount = valueCountInput.trim();
      if (rawValueCount) {
        const parsedValueCount = Number(rawValueCount);
        if (!Number.isInteger(parsedValueCount) || parsedValueCount < 1 || parsedValueCount > 8) {
          setError('Value count must be a whole number between 1 and 8.');
          return;
        }
        valueCount = parsedValueCount;
      }
    }

    setBusy('save');
    setError(null);
    setInfo(null);
    try {
      const request: Sdi12ConfigRequest = {
        probe_profile: selectedProfile.id,
        ...(depthsChanged ? { depths } : {}),
        ...(isVariableCountProfile ? { value_count: valueCount } : {}),
      };
      await putSdi12Config(device.deveui, request);
      setInfo('SDI-12 configuration saved.');
      onUpdate();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to save SDI-12 configuration.'));
    } finally {
      setBusy(null);
    }
  };

  const deployment = device.sdi12_recipe_deployment;
  const draftLayout = canonicalSentekLayout(sentekAddress, sentekSensors);
  const canApply = isSentekProfile && draftLayout !== null && draftLayout === confirmedLayout && busy === null;
  const handleApply = async () => {
    if (!canApply) return;
    setBusy('apply'); setShowApplyConfirm(false); setError(null); setInfo(null);
    try {
      const result = await postSdi12RecipeApply(device.deveui);
      setInfo(t('sdi12.requestAccepted', { version: result?.desired_version ?? 'unknown', status: result?.status ?? 'unknown' }));
      onUpdate();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to apply acquisition configuration.'));
    } finally { setBusy(null); }
  };
  const handleRollback = async () => {
    if (busy !== null || !deployment?.compatible_available) return;
    setBusy('rollback'); setError(null); setInfo(null);
    try {
      const result = await postSdi12RecipeRollback(device.deveui);
      setInfo(t('sdi12.rollbackRequestAccepted', { version: result?.desired_version ?? 'unknown', status: result?.status ?? 'unknown' }));
      onUpdate();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to roll back acquisition configuration.'));
    } finally { setBusy(null); }
  };

  const handleIdentify = async () => {
    setBusy('identify');
    setError(null);
    setInfo(null);
    try {
      await postSdi12Identify(device.deveui);
      setIdentifyPending(true);
      setInfo('Identification requested; waiting for the next uplink.');
      onUpdate();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to request SDI-12 probe identification.'));
    } finally {
      setBusy(null);
    }
  };

  const pending = identifyPending || device.sdi12_probe_status === 'pending_identify';
  const pendingMinutesAgo = pending ? pendingMinutes(device.updated_at) : null;
  const pendingNoResponse = pendingMinutesAgo != null && pendingMinutesAgo > SDI12_IDENTIFY_TIMEOUT_MINUTES;
  const identifyLabel = device.sdi12_probe_status ? t('sdi12.reCheck') : t('sdi12.identify');

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`sdi12-settings-title-${device.deveui}`}
        className="mx-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0">
            <h2 id={`sdi12-settings-title-${device.deveui}`} className="text-xl font-bold text-[var(--text)]">
              SDI-12 probe settings
            </h2>
            <p className="mt-1 truncate text-sm text-[var(--text-tertiary)]">{device.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)]"
          >
            Close
          </button>
        </div>

        <div className="max-h-[calc(100vh-8rem)] overflow-y-auto p-5">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
            <label htmlFor={`sdi12-profile-${device.deveui}`} className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
              Probe profile
            </label>
            <select
              id={`sdi12-profile-${device.deveui}`}
              value={selectedProfileId}
              onChange={handleProfileChange}
              disabled={loading || busy !== null}
              className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            >
              <option value="" disabled>Select a profile</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}{profile.provisional ? ' (unverified)' : ''}
                </option>
              ))}
            </select>
          </div>

          {device.sdi12_probe_status === 'unmatched' && device.sdi12_identity && (
            <p className="mt-3 rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn-text)]">
              Unmatched probe identity: <span className="font-mono">{device.sdi12_identity}</span>
            </p>
          )}

          {isVariableCountProfile && !isSentekProfile && (
            <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
              <label htmlFor={`sdi12-value-count-${device.deveui}`} className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                {t('sdi12.valueCount')}
              </label>
              <input
                id={`sdi12-value-count-${device.deveui}`}
                type="number"
                min={1}
                max={8}
                step={1}
                value={valueCountInput}
                disabled={busy !== null}
                onChange={(event) => setValueCountInput(event.target.value)}
                className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              />
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('sdi12.valueCountHelp')}</p>
            </div>
          )}

          {isSentekProfile && (
            <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Connected Sentek modules</p>
              <label htmlFor={`sdi12-address-${device.deveui}`} className="mt-3 block text-xs font-semibold text-[var(--text-secondary)]">SDI-12 address</label>
              <input id={`sdi12-address-${device.deveui}`} value={sentekAddress} maxLength={1} disabled={busy !== null}
                onChange={(event) => {
                  setSentekAddressTouched(true);
                  setSentekAddress(event.target.value);
                }}
                className="mt-1 w-20 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]" />
              <div className="mt-3 space-y-2">
                {sentekSensors.map((sensor, rowIndex) => (
                  <div key={`${sensor.channel}-${rowIndex}`} className="grid grid-cols-2 gap-2 rounded-lg border border-[var(--border)] p-2 sm:grid-cols-5">
                    <label className="text-xs">Channel<input aria-label={`Channel ${rowIndex + 1}`} type="number" min={1} max={10} value={sensor.channel} disabled={busy !== null}
                      onChange={(event) => setSentekSensors((rows) => rows.map((row, index) => index === rowIndex ? { ...row, channel: Number(event.target.value) } : row))}
                      className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1" /></label>
                    <label className="text-xs">Response position<input aria-label={`Response position ${rowIndex + 1}`} type="number" min={1} max={10} value={sensor.response_position} disabled={busy !== null}
                      onChange={(event) => setSentekSensors((rows) => rows.map((row, index) => index === rowIndex ? { ...row, response_position: Number(event.target.value) } : row))}
                      className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1" /></label>
                    <label className="text-xs">Depth (cm)<input aria-label={`Depth ${rowIndex + 1} (cm)`} type="number" min={1} max={1000} value={sensor.depth_cm} disabled={busy !== null}
                      onChange={(event) => setSentekSensors((rows) => rows.map((row, index) => index === rowIndex ? { ...row, depth_cm: Number(event.target.value) } : row))}
                      className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1" /></label>
                    <label className="text-xs">Module type<select aria-label={`Module type ${rowIndex + 1}`} value={sensor.type} disabled={busy !== null}
                      onChange={(event) => setSentekSensors((rows) => rows.map((row, index) => index === rowIndex ? { ...row, type: event.target.value as SentekSensorType } : row))}
                      className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1"><option value="ENVIROSCAN">EnviroSCAN</option><option value="TRISCAN">TriSCAN</option></select></label>
                    <button type="button" disabled={busy !== null || sentekSensors.length === 1} onClick={() => setSentekSensors((rows) => rows
                      .filter((_, index) => index !== rowIndex)
                      .map((row, index) => ({ ...row, response_position: index + 1 })))}
                      className="self-end rounded border border-[var(--border)] px-2 py-1 text-sm disabled:opacity-40">Remove</button>
                  </div>
                ))}
              </div>
              <button type="button" disabled={busy !== null || sentekSensors.length >= 10}
                onClick={() => setSentekSensors((rows) => {
                  const used = new Set(rows.map((row) => row.channel));
                  const channel = Array.from({ length: 10 }, (_, index) => index + 1).find((candidate) => !used.has(candidate)) ?? 10;
                  return [...rows, { channel, response_position: rows.length + 1, depth_cm: (rows.length + 1) * 10, type: 'ENVIROSCAN' }];
                })}
                className="mt-3 rounded border border-[var(--border)] px-3 py-1.5 text-sm">Add module</button>
            </div>
          )}

          {isTensiomarkProfile && (
            <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('sdi12.tensiomark.title')}</p>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('sdi12.tensiomark.qualification')}</p>
              <div className="mt-3 space-y-2">
                {tensiomarkSensors.map((sensor, rowIndex) => (
                  <div key={`${sensor.channel}-${rowIndex}`} className="grid grid-cols-2 gap-2 rounded-lg border border-[var(--border)] p-2 sm:grid-cols-4">
                    <label className="text-xs">{t('sdi12.tensiomark.address')}<input aria-label={t('sdi12.tensiomark.addressAria', { row: rowIndex + 1 })} value={sensor.address} maxLength={1} disabled={busy !== null}
                      onChange={(event) => setTensiomarkSensors((rows) => rows.map((row, index) => index === rowIndex ? { ...row, address: event.target.value } : row))}
                      className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1" /></label>
                    <label className="text-xs">{t('sdi12.tensiomark.channel')}<select aria-label={t('sdi12.tensiomark.channelAria', { row: rowIndex + 1 })} value={sensor.channel} disabled={busy !== null}
                      onChange={(event) => setTensiomarkSensors((rows) => rows.map((row, index) => index === rowIndex ? { ...row, channel: Number(event.target.value) as 1 | 2 } : row))}
                      className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1"><option value={1}>1</option><option value={2}>2</option></select></label>
                    <label className="text-xs">{t('sdi12.tensiomark.identity')}<input aria-label={t('sdi12.tensiomark.identityAria', { row: rowIndex + 1 })} value={sensor.identity} disabled={busy !== null}
                      placeholder={t('sdi12.tensiomark.identityExample', { address: sensor.address || '1' })}
                      onChange={(event) => setTensiomarkSensors((rows) => rows.map((row, index) => index === rowIndex ? { ...row, identity: event.target.value } : row))}
                      className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1" /></label>
                    <label className="text-xs">{t('sdi12.tensiomark.depthCmLabel')}<input aria-label={t('sdi12.tensiomark.depthAria', { row: rowIndex + 1 })} type="number" min={1} max={1000} value={sensor.depth_cm ?? ''} disabled={busy !== null}
                      onChange={(event) => setTensiomarkSensors((rows) => rows.map((row, index) => index === rowIndex ? { ...row, depth_cm: event.target.value === '' ? null : Number(event.target.value) } : row))}
                      className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1" /></label>
                    <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 sm:col-span-4">
                      <p className="text-xs text-[var(--text-tertiary)]">{t('sdi12.tensiomark.calibrationRange')}</p>
                      {tensiomarkSensors.length > 1 && (
                        <button type="button" disabled={busy !== null} aria-label={t('sdi12.tensiomark.removeSensorAria', { row: rowIndex + 1 })}
                          onClick={() => setTensiomarkSensors((rows) => rows.filter((_, index) => index !== rowIndex))}
                          className="rounded border border-[var(--border)] px-2 py-1 text-xs">{t('sdi12.tensiomark.removeSensor')}</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {tensiomarkSensors.length < 2 && (
                <button type="button" disabled={busy !== null} onClick={() => setTensiomarkSensors((rows) => [...rows, blankTensiomarkSensor(rows.some((row) => row.channel === 1) ? 2 : 1)])}
                  className="mt-3 rounded border border-[var(--border)] px-3 py-1.5 text-sm">{t('sdi12.tensiomark.addSensor')}</button>
              )}
              <label className="mt-3 flex items-start gap-2 text-sm text-[var(--text)]">
                <input type="checkbox" checked={tensiomarkConfirmed} disabled={busy !== null} onChange={(event) => setTensiomarkConfirmed(event.target.checked)} />
                {t('sdi12.tensiomark.confirmation')}
              </label>
            </div>
          )}

          {selectedProfile && !isSentekProfile && !isTensiomarkProfile && depthSlots(selectedProfile).length > 0 && (
            <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Probe depths</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {depthSlots(selectedProfile).map((slot) => (
                  <div key={slot}>
                    <label htmlFor={`sdi12-depth-${device.deveui}-${slot}`} className="mb-1 block text-xs font-semibold text-[var(--text-secondary)]">
                      Depth slot {slot} (cm)
                    </label>
                    <input
                      id={`sdi12-depth-${device.deveui}-${slot}`}
                      type="number"
                      min={0}
                      max={500}
                      step={1}
                      value={depthInputs[String(slot)] ?? ''}
                      disabled={busy !== null}
                      onChange={(event) => setDepthInputs((current) => ({ ...current, [String(slot)]: event.target.value }))}
                      className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleIdentify}
              disabled={busy !== null}
              className="rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === 'identify' ? 'Requesting…' : identifyLabel}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy !== null || loading || !selectedProfile}
              className="rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            {isSentekProfile && (
              <button type="button" onClick={() => setShowApplyConfirm(true)} disabled={!canApply}
                className="rounded-lg border border-[var(--primary)] px-3 py-2 text-sm font-semibold text-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-60">
                {t('sdi12.apply')}
              </button>
            )}
            {isSentekProfile && deployment?.compatible_available && (
              <button type="button" onClick={handleRollback} disabled={busy !== null}
                className="rounded-lg border border-[var(--warn-border)] px-3 py-2 text-sm font-semibold text-[var(--warn-text)] disabled:cursor-not-allowed disabled:opacity-60">
                {busy === 'rollback' ? t('sdi12.rollingBack') : t('sdi12.rollback')}
              </button>
            )}
          </div>

          {showApplyConfirm && (
            <div className="mt-3 rounded-lg bg-[var(--warn-bg)] p-3 text-sm text-[var(--warn-text)]">
              {t('sdi12.applyConfirmation')}
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={handleApply} disabled={busy !== null} className="rounded border px-3 py-1 disabled:opacity-60">{t('sdi12.confirmApply')}</button>
                <button type="button" onClick={() => setShowApplyConfirm(false)} disabled={busy !== null} className="rounded border px-3 py-1 disabled:opacity-60">Cancel</button>
              </div>
            </div>
          )}
          {deployment && <p className="mt-3 text-sm text-[var(--text-tertiary)]">Deployment status: {deployment.status}</p>}
          {deployment?.status === 'degraded' && (
            <p className="mt-3 rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error-text)]">
              {t('sdi12.degraded')}{deployment.last_error_code ? `: ${deployment.last_error_code}` : '.'}
            </p>
          )}

          {pending && !identifyPending && (
            pendingNoResponse ? (
              <div className="mt-3 rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn-text)]">
                <p>{t('sdi12.noResponse')}</p>
                <p className="mt-1">{t('sdi12.actButtonHint')}</p>
              </div>
            ) : (
              <p className="mt-3 text-sm text-[var(--warn-text)]">{pendingAgeLabel(pendingMinutesAgo)}</p>
            )
          )}
          {info && <p className="mt-3 text-sm text-[var(--text-tertiary)]">{info}</p>}
          {error && <p className="mt-3 text-sm text-[var(--error-text)]">{error}</p>}
        </div>
      </div>
    </div>
  );
};
