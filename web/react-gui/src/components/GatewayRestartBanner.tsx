import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSystemStatus } from '../hooks/useSystemStatus';

type RestartCountdownKey =
  | 'restart.gateway_identity_change'
  | 'restart.chirpstack_bootstrap'
  | 'restart.account_link'
  | 'restart.account_unlink';

const REASON_KEYS: Readonly<Partial<Record<string, RestartCountdownKey>>> = {
  gateway_identity_change: 'restart.gateway_identity_change',
  chirpstack_bootstrap: 'restart.chirpstack_bootstrap',
  account_link: 'restart.account_link',
  account_unlink: 'restart.account_unlink',
};

export function GatewayRestartBanner() {
  const { t } = useTranslation('common');
  const stats = useSystemStatus();
  const restartPending = stats?.restartPending;
  const restartAtMs = useMemo(() => {
    if (!restartPending?.restartAt) return null;
    const parsed = Date.parse(restartPending.restartAt);
    return Number.isFinite(parsed) ? parsed : null;
  }, [restartPending?.restartAt]);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (restartAtMs === null) {
      setRemainingSeconds(null);
      return;
    }

    const updateCountdown = () => {
      setRemainingSeconds(Math.max(0, Math.ceil((restartAtMs - Date.now()) / 1000)));
    };

    updateCountdown();
    const interval = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(interval);
  }, [restartAtMs]);

  if (!restartPending || restartAtMs === null || remainingSeconds === null) return null;

  const message = remainingSeconds === 0
    ? t('restart.in_progress')
    : t(REASON_KEYS[restartPending.reason] ?? 'restart.generic', { count: remainingSeconds });

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-b border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-3 text-center text-sm font-semibold text-[var(--warn-text)]"
    >
      {message}
    </div>
  );
}
