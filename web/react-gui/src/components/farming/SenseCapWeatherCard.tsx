import React, { useRef, useState } from 'react';
import type { Device } from '../../types/farming';
import { devicesAPI, getApiErrorMessage, s2120API } from '../../services/api';
import { useDismissOnPointerDown } from '../../hooks/useDismissOnPointerDown';
import { useTranslation } from 'react-i18next';

interface Props {
  device: Device;
  onRemove?: () => void;
  onUpdate?: () => void;
  allZones?: Array<{ id: number; name: string }>;
}

function fmtNum(v: number | null | undefined, decimals: number, unit: string): string {
  if (v == null) return '—';
  return `${v.toFixed(decimals)} ${unit}`;
}

function windDirLabel(deg: number | null | undefined): string {
  if (deg == null) return '—';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8] + ' ' + Math.round(deg) + '°';
}

function fmtLux(v: number | null | undefined): string {
  if (v == null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k lux` : `${Math.round(v)} lux`;
}

function lastSeenLabel(lastSeen: string | null | undefined): string {
  if (!lastSeen) return 'never';
  const diff = Math.floor((Date.now() - new Date(lastSeen).getTime()) / 60000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff} min ago`;
  return `${Math.floor(diff / 60)}h ago`;
}

const ZonePickerPanel: React.FC<{
  device: Device;
  allZones: Array<{ id: number; name: string }>;
  onClose: () => void;
  onUpdate?: () => void;
}> = ({ device, allZones, onClose, onUpdate }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set(device.zone_ids ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useDismissOnPointerDown(ref, onClose);

  const toggle = (id: number) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await s2120API.setZoneAssignments(device.deveui, Array.from(selected));
      onUpdate?.();
      onClose();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to save'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={ref}
      className="absolute top-8 right-0 z-20 w-56 bg-[var(--card)] border border-[var(--border)] rounded-xl shadow-lg p-3"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-2">
        Zone Assignments
      </p>
      <div className="flex flex-col gap-1 mb-3 max-h-40 overflow-y-auto">
        {allZones.map(z => (
          <label key={z.id} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={selected.has(z.id)}
              onChange={() => toggle(z.id)}
              className="rounded"
            />
            <span className="truncate">{z.name}</span>
          </label>
        ))}
        {allZones.length === 0 && (
          <p className="text-xs text-[var(--text-tertiary)]">No zones available</p>
        )}
      </div>
      {error && <p className="text-xs text-[var(--error-text)] mb-2">{error}</p>}
      <button
        onClick={save}
        disabled={busy}
        className="w-full rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
};

export const SenseCapWeatherCard: React.FC<Props> = ({ device, onRemove, onUpdate, allZones = [] }) => {
  const { t: tc } = useTranslation('common');
  const d = device.latest_data ?? {};
  const [showConfig, setShowConfig] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRemove = async () => {
    setIsRemoving(true);
    setError(null);
    try {
      await devicesAPI.remove(device.deveui);
      onRemove?.();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to remove device'));
      setIsRemoving(false);
    }
  };

  const zoneLabel = device.zone_names?.length
    ? device.zone_names.join(' · ')
    : 'No zones assigned';

  return (
    <div className="rounded-xl p-4 border shadow-sm transition-colors bg-[var(--surface)] border-[var(--border)] hover:border-[var(--focus)]">
      {/* Header row 1 */}
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <h3 className="text-base font-semibold text-[var(--text)] truncate leading-tight">
          {device.name}
        </h3>
        <div className="flex items-center gap-1.5 shrink-0 relative">
          <span className="bg-sky-100 text-sky-800 px-2 py-0.5 rounded-md text-xs font-semibold tracking-wide">
            S2120
          </span>
          <button
            onClick={() => setShowConfig(v => !v)}
            className={`p-1.5 rounded-md transition-colors ${
              showConfig
                ? 'bg-[var(--primary)] text-white'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--card)] hover:text-[var(--text)]'
            }`}
            title="Manage zone assignments"
          >
            ⚙
          </button>
          {showConfig && (
            <ZonePickerPanel
              device={device}
              allZones={allZones}
              onClose={() => setShowConfig(false)}
              onUpdate={onUpdate}
            />
          )}
          <button
            onClick={() => setShowConfirm(true)}
            disabled={isRemoving}
            className="p-1.5 rounded-md bg-[var(--error-bg)] text-[var(--error-text)] hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            title="Remove device"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Header row 2: EUI */}
      <p className="text-xs text-[var(--text-tertiary)] font-mono mb-3 truncate">{device.deveui}</p>

      {error && (
        <div className="bg-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg mb-3 text-sm">
          {error}
        </div>
      )}

      {showConfirm && (
        <div className="bg-[var(--warn-bg)] border-2 border-[var(--warn-border)] text-[var(--warn-text)] px-4 py-3 rounded-lg mb-4">
          <p className="font-bold mb-2">Remove weather station?</p>
          <p className="text-sm mb-3">This will delete all stored readings and zone assignments.</p>
          <div className="flex gap-2">
            <button
              onClick={handleRemove}
              disabled={isRemoving}
              className="bg-[var(--error-bg)] text-[var(--error-text)] font-bold px-4 py-2 rounded-lg disabled:cursor-not-allowed"
            >
              {isRemoving ? 'Removing…' : 'Yes, remove'}
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              disabled={isRemoving}
              className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold px-4 py-2 rounded-lg"
            >
              {tc('cancel')}
            </button>
          </div>
        </div>
      )}

      {/* 2-col parameter grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-[var(--card)] rounded-lg p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">Air Temperature</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: '#ea580c' }}>
            {fmtNum(d.ambient_temperature, 1, '°C')}
          </p>
        </div>

        <div className="bg-[var(--card)] rounded-lg p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">Humidity</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: '#0891b2' }}>
            {fmtNum(d.relative_humidity, 0, '%')}
          </p>
        </div>

        <div className="bg-[var(--card)] rounded-lg p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">Wind Speed</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: '#4f46e5' }}>
            {fmtNum(d.wind_speed_mps, 1, 'm/s')}
          </p>
          {d.wind_gust_mps != null && (
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">gust {d.wind_gust_mps.toFixed(1)} m/s</p>
          )}
        </div>

        <div className="bg-[var(--card)] rounded-lg p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">Wind Direction</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: '#7c3aed' }}>
            {windDirLabel(d.wind_direction_deg)}
          </p>
        </div>

        <div className="bg-[var(--card)] rounded-lg p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">Rain Today</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: '#2563eb' }}>
            {fmtNum(d.rain_mm_today, 1, 'mm')}
          </p>
          {d.rain_mm_delta != null && d.rain_mm_delta > 0 && (
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">+{d.rain_mm_delta.toFixed(1)} mm last uplink</p>
          )}
        </div>

        <div className="bg-[var(--card)] rounded-lg p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">Pressure</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: '#475569' }}>
            {fmtNum(d.barometric_pressure_hpa, 0, 'hPa')}
          </p>
        </div>

        <div className="bg-[var(--card)] rounded-lg p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">Light Intensity</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: '#d97706' }}>
            {fmtLux(d.light_lux)}
          </p>
        </div>

        <div className="bg-[var(--card)] rounded-lg p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">UV Index</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: '#ca8a04' }}>
            {fmtNum(d.uv_index, 1, 'UVI')}
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="flex justify-between items-center mt-3">
        <p className="text-xs text-[var(--text-tertiary)] truncate max-w-[60%]">
          Zones: <span className="text-[var(--text)] font-medium">{zoneLabel}</span>
        </p>
        <p className="text-xs text-[var(--text-tertiary)] shrink-0">
          {d.bat_pct != null ? `🔋 ${Math.round(d.bat_pct)}% · ` : ''}{lastSeenLabel(device.last_seen)}
        </p>
      </div>
    </div>
  );
};
