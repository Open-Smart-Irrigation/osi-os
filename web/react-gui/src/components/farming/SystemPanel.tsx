import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { systemAPI, type SystemStats } from '../../services/api';
import { useScope } from '../../contexts/ScopeContext';

const FAN_PRESETS = [
  { labelKey: 'systemPanel.fanOff', speed: 0 },
  { labelKey: 'systemPanel.fanLow', speed: 64 },
  { labelKey: 'systemPanel.fanMedium', speed: 128 },
  { labelKey: 'systemPanel.fanHigh', speed: 192 },
  { labelKey: 'systemPanel.fanMax', speed: 255 },
] as const;

function tempColor(c: number): string {
  if (c < 55) return 'var(--toggle-on)';
  if (c < 70) return 'var(--warn-border)';
  return 'var(--error-text)';
}

function loadColor(load: number, cores: number): string {
  const pct = load / cores;
  if (pct < 0.6) return 'var(--toggle-on)';
  if (pct < 0.85) return 'var(--warn-border)';
  return 'var(--error-text)';
}

export const SystemPanel: React.FC = () => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const { isAdmin, isScoped, resolved: scopeResolved, loading: scopeLoading } = useScope();
  // F20: the backend (#244) allows reboot/fan writes from admins only once
  // OSI_SCOPED_ACCESS is on; non-scoped installs keep today's behavior
  // unchanged (no role gate at all). Fail closed while scope is still
  // resolving, same D5 pattern used elsewhere in the GUI.
  //
  // F51: `isScoped` reads `false` while the profile hasn't loaded yet
  // (ScopeContext derives it from `profile?.features`, and `profile` starts
  // null), which is indistinguishable from a genuinely non-scoped install --
  // so gating only on `isScoped` failed OPEN during that window on a scoped
  // gateway. `scopeResolved` (profile loaded, no error) is required before
  // trusting `isScoped` at all.
  const systemWriteAllowed = scopeLoading || !scopeResolved ? false : (isScoped ? isAdmin : true);
  const adminOnlyTitle = systemWriteAllowed ? undefined : tc('adminOnly');

  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [fanSpeed, setFanSpeed] = useState<number>(0);
  const [fanBusy, setFanBusy] = useState(false);
  const [fanError, setFanError] = useState<string | null>(null);

  const [showRebootConfirm, setShowRebootConfirm] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [rebootMsg, setRebootMsg] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const data = await systemAPI.getStats();
      setStats(data);
      setLastUpdated(new Date());
      setError(null);
      if (data.fan_value !== null) setFanSpeed(data.fan_value);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || t('systemPanel.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchStats();
    const iv = setInterval(fetchStats, 30000);
    return () => clearInterval(iv);
  }, [fetchStats]);

  const handleFan = async (speed: number) => {
    if (!systemWriteAllowed) return;
    setFanBusy(true);
    setFanError(null);
    try {
      await systemAPI.setFan(speed);
      setFanSpeed(speed);
    } catch (e: any) {
      setFanError(e.response?.data?.error || t('systemPanel.fanError'));
    } finally {
      setFanBusy(false);
    }
  };

  const handleReboot = async () => {
    if (!systemWriteAllowed) return;
    setRebooting(true);
    try {
      await systemAPI.reboot();
      setRebootMsg(t('systemPanel.rebootingMessage'));
      setShowRebootConfirm(false);
    } catch (e: any) {
      setRebootMsg(e.response?.data?.error || t('systemPanel.rebootError'));
    } finally {
      setRebooting(false);
    }
  };

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--text)]">{t('systemPanel.title')}</h2>
          <p className="text-xs text-[var(--text-tertiary)]">{t('systemPanel.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-[var(--text-tertiary)] text-xs">
              {t('systemPanel.updated', { time: lastUpdated.toLocaleTimeString() })}
            </span>
          )}
          <button
            onClick={fetchStats}
            disabled={loading}
            className="touch-target px-2.5 py-1.5 rounded-md bg-[var(--card)] hover:bg-[var(--border)] text-[var(--text)] text-sm font-semibold transition-colors disabled:opacity-50"
          >
            ↻ {t('systemPanel.refresh')}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-[var(--error-bg)] text-[var(--error-text)] rounded-lg px-4 py-3 mb-4 text-sm">
          {error}
        </div>
      )}

      {loading && !stats && (
        <div className="flex justify-center py-8">
          <div className="animate-spin h-8 w-8 border-4 border-[var(--primary)] border-t-transparent rounded-full" />
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">

          {/* CPU Temperature */}
          <div className="bg-[var(--card)] rounded-lg p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">{t('systemPanel.cpuTemperature')}</p>
            <p className="text-2xl font-bold tabular-nums" style={{ color: tempColor(stats.cpu_temp_c) }}>
              {stats.cpu_temp_c.toFixed(1)}°C
            </p>
            <div className="mt-2 h-2 bg-[var(--border)] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(100, (stats.cpu_temp_c / 85) * 100)}%`,
                  background: tempColor(stats.cpu_temp_c),
                }}
              />
            </div>
            <p className="text-[var(--text-tertiary)] text-xs mt-1">{t('systemPanel.maxTemperature', { max: 85 })}</p>
          </div>

          {/* Memory */}
          <div className="bg-[var(--card)] rounded-lg p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">{t('systemPanel.memory')}</p>
            <p className="text-2xl font-bold tabular-nums text-[var(--text)]">{stats.mem_percent}%</p>
            <div className="mt-2 h-2 bg-[var(--border)] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--primary)] transition-all duration-500"
                style={{ width: `${stats.mem_percent}%` }}
              />
            </div>
            <p className="text-[var(--text-tertiary)] text-xs mt-1">
              {t('systemPanel.memoryUsed', { used: stats.mem_used_mb, total: stats.mem_total_mb })}
            </p>
          </div>

          {/* CPU Load */}
          <div className="bg-[var(--card)] rounded-lg p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">
              {t('systemPanel.cpuLoad', { count: stats.cpu_count })}
            </p>
            <p
              className="text-2xl font-bold tabular-nums"
              style={{ color: loadColor(stats.load_1, stats.cpu_count) }}
            >
              {stats.load_1.toFixed(2)}
            </p>
            <div className="mt-2 flex gap-2 text-xs text-[var(--text-tertiary)]">
              <span>{t('systemPanel.load1m')} <strong className="text-[var(--text)]">{stats.load_1.toFixed(2)}</strong></span>
              <span>{t('systemPanel.load5m')} <strong className="text-[var(--text)]">{stats.load_5.toFixed(2)}</strong></span>
              <span>{t('systemPanel.load15m')} <strong className="text-[var(--text)]">{stats.load_15.toFixed(2)}</strong></span>
            </div>
          </div>

          {/* Fan Control */}
          <div className="bg-[var(--card)] rounded-lg p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">{t('systemPanel.fanControl')}</p>
            {stats.fan_available ? (
              <>
                <p className="text-[var(--text)] text-sm mb-2">
                  {t('systemPanel.fanCurrent')} <strong>{fanSpeed === 0 ? t('systemPanel.fanOff') : fanSpeed >= 255 ? t('systemPanel.fanMax') : fanSpeed}</strong>
                  {stats.fan_mode === 'pwm' && <span className="text-[var(--text-tertiary)]"> / 255</span>}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {FAN_PRESETS.map(p => (
                    <button
                      key={p.speed}
                      onClick={() => handleFan(p.speed)}
                      disabled={fanBusy || !systemWriteAllowed}
                      aria-disabled={fanBusy || !systemWriteAllowed}
                      aria-describedby={systemWriteAllowed ? undefined : 'system-panel-fan-admin-hint'}
                      title={adminOnlyTitle}
                      className={`touch-target px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 ${
                        fanSpeed === p.speed
                          ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                          : 'bg-[var(--border)] text-[var(--text)] hover:bg-[var(--secondary-bg)]'
                      }`}
                    >
                      {t(p.labelKey)}
                    </button>
                  ))}
                </div>
                {!systemWriteAllowed && (
                  <p id="system-panel-fan-admin-hint" className="text-[var(--text-tertiary)] text-xs mt-2">
                    {tc('adminOnly')}
                  </p>
                )}
                {fanError && (
                  <p className="text-[var(--error-text)] text-xs mt-2">{fanError}</p>
                )}
              </>
            ) : (
              <p className="text-[var(--text-tertiary)] text-sm mt-1">{t('systemPanel.noFanDetected')}</p>
            )}
          </div>
        </div>
      )}

      {/* Reboot */}
      <div className="mt-4 pt-3 border-t border-[var(--border)] flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          {rebootMsg ? (
            <p className="text-[var(--warn-text)] text-sm font-semibold">{rebootMsg}</p>
          ) : showRebootConfirm ? (
            <>
              <p className="text-[var(--text)] text-sm font-semibold">{t('systemPanel.rebootConfirmTitle')}</p>
              <button
                onClick={handleReboot}
                disabled={rebooting || !systemWriteAllowed}
                aria-disabled={rebooting || !systemWriteAllowed}
                aria-describedby={systemWriteAllowed ? undefined : 'system-panel-reboot-admin-hint'}
                title={adminOnlyTitle}
                className="bg-[var(--error-bg)] hover:opacity-90 text-[var(--error-text)] font-bold px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {rebooting && <span className="animate-spin h-3.5 w-3.5 border-2 border-current border-t-transparent rounded-full" />}
                {t('systemPanel.rebootConfirmYes')}
              </button>
              <button
                onClick={() => setShowRebootConfirm(false)}
                className="bg-[var(--card)] hover:bg-[var(--border)] text-[var(--text)] font-bold px-4 py-2 rounded-lg text-sm"
              >
                {tc('cancel')}
              </button>
            </>
          ) : (
            <button
              onClick={() => setShowRebootConfirm(true)}
              disabled={!systemWriteAllowed}
              aria-disabled={!systemWriteAllowed}
              aria-describedby={systemWriteAllowed ? undefined : 'system-panel-reboot-admin-hint'}
              title={adminOnlyTitle}
              className="bg-[var(--card)] hover:bg-[var(--error-bg)] text-[var(--danger-fg)] hover:text-[var(--error-text)] font-semibold px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50"
            >
              ⟳ {t('systemPanel.rebootButton')}
            </button>
          )}
        </div>
        {!systemWriteAllowed && (
          <p id="system-panel-reboot-admin-hint" className="text-[var(--text-tertiary)] text-xs">
            {tc('adminOnly')}
          </p>
        )}
      </div>
    </div>
  );
};
