import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Device, Sdi12Profile } from '../../types/farming';
import {
  fetchSdi12Profiles,
  getApiErrorMessage,
  postSdi12Identify,
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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'identify' | 'save' | null>(null);
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

  // Variable-count profiles have no fixed expectedValues -- this is the same
  // set the edge normalizer treats as learnable (SENTEK_ENVIROSCAN,
  // DELTAT_PR2_4, DELTAT_PR2_6, and the pre-existing GENERIC_VWC escape
  // hatch). Fixed-shape profiles like HYDRASCOUT/TENSIOMARK/IMKO_PICO64
  // never show this field.
  const isVariableCountProfile = selectedProfile ? selectedProfile.expectedValues == null : false;

  const handleProfileChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedProfileId(event.target.value);
    setError(null);
    setInfo(null);
  };

  const handleSave = async () => {
    if (!selectedProfile) {
      setError('Select a probe profile.');
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

          {isVariableCountProfile && (
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

          {selectedProfile && depthSlots(selectedProfile).length > 0 && (
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
          </div>

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
