import React, { useState } from 'react';
import type { Device } from '../../types/farming';
import { devicesAPI } from '../../services/api';
import { useTranslation } from 'react-i18next';

interface StregaValveCardProps {
  device: Device;
  onUpdate: () => void;
  onRemove?: () => void;
}

export const StregaValveCard: React.FC<StregaValveCardProps> = ({ device, onUpdate, onRemove }) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const [loading, setLoading] = useState<'OPEN' | 'CLOSE' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const lastSeen = new Date(device.last_seen);
  const now = new Date();
  const minutesAgo = Math.floor((now.getTime() - lastSeen.getTime()) / (1000 * 60));

  const isOpen = device.current_state === 'OPEN';

  const handleAction = async (action: 'OPEN' | 'CLOSE') => {
    setLoading(action);
    setError(null);
    try {
      await devicesAPI.controlValve(device.deveui, { action });
      onUpdate(); // Refresh devices list
    } catch (err: any) {
      setError(err.response?.data?.message || `Failed to ${action.toLowerCase()} valve`);
    } finally {
      setLoading(null);
    }
  };

  const handleRemove = async () => {
    setIsRemoving(true);
    setError(null);
    try {
      await devicesAPI.remove(device.deveui);
      if (onRemove) {
        onRemove();
      }
    } catch (err: any) {
      setError(err.response?.data?.message || t('stregaValve.failedToRemove'));
      setIsRemoving(false);
    }
  };

  return (
    <div className="bg-[var(--surface)] border-2 border-[var(--border)] hover:border-[var(--focus)] rounded-xl p-6 shadow-lg transition-all">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="text-2xl font-bold text-[var(--text)] mb-1 high-contrast-text">
            {device.name}
          </h3>
          <p className="text-[var(--text-secondary)] text-sm">{device.deveui}</p>
        </div>
        <div className="flex items-start gap-2">
          <div className="bg-[var(--primary)] text-white px-3 py-1 rounded-lg text-sm font-semibold">
            {t('stregaValve.badge')}
          </div>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={isRemoving || loading !== null}
            className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] px-3 py-1 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            title="Remove device"
          >
            ✕
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {showConfirm && (
        <div className="bg-[var(--warn-bg)] border-2 border-[var(--warn-border)] text-[var(--warn-text)] px-4 py-3 rounded-lg mb-4">
          <p className="font-bold mb-2">{t('stregaValve.removeConfirm')}</p>
          <p className="text-sm mb-3">{t('stregaValve.removeSubtitle')}</p>
          <div className="flex gap-2">
            <button
              onClick={handleRemove}
              disabled={isRemoving}
              className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center gap-2 disabled:text-[var(--text-disabled)]"
            >
              {isRemoving ? (
                <>
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                  {t('stregaValve.removing')}
                </>
              ) : (
                t('stregaValve.yesRemove')
              )}
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              disabled={isRemoving}
              className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] disabled:bg-[var(--border)] text-[var(--text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            >
              {tc('cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Status Display */}
      <div className="bg-[var(--card)] rounded-lg p-6 mb-6">
        <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-3">{t('stregaValve.status')}</p>
        <div className="flex items-center gap-3">
          <div
            className={`w-6 h-6 rounded-full ${
              isOpen ? 'bg-[var(--toggle-on)] animate-pulse' : 'bg-[var(--toggle-off)]'
            }`}
          />
          <p
            className={`text-3xl font-bold ${
              isOpen ? 'text-[var(--toggle-on)]' : 'text-[var(--text-tertiary)]'
            }`}
          >
            {isOpen ? t('stregaValve.open') : t('stregaValve.closed')}
          </p>
        </div>
        {device.target_state && device.target_state !== device.current_state && (
          <p className="text-[var(--text-secondary)] text-sm mt-2">
            {t('stregaValve.target', { state: device.target_state })}
          </p>
        )}
      </div>

      {/* Control Buttons */}
      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => handleAction('OPEN')}
          disabled={loading !== null}
          className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:bg-[var(--border)] text-white font-bold text-lg py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed disabled:text-[var(--text-disabled)] flex items-center justify-center gap-2"
        >
          {loading === 'OPEN' ? (
            <>
              <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
              {t('stregaValve.opening')}
            </>
          ) : (
            t('stregaValve.open')
          )}
        </button>
        <button
          onClick={() => handleAction('CLOSE')}
          disabled={loading !== null}
          className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] disabled:bg-[var(--border)] text-[var(--text)] font-bold text-lg py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed disabled:text-[var(--text-disabled)] flex items-center justify-center gap-2"
        >
          {loading === 'CLOSE' ? (
            <>
              <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
              {t('stregaValve.closing')}
            </>
          ) : (
            t('stregaValve.closed')
          )}
        </button>
      </div>

      <div className="mt-4 pt-4 border-t border-[var(--border)]">
        <p className="text-[var(--text-tertiary)] text-sm">
          {t('stregaValve.lastSeen', { minutes: minutesAgo })}
        </p>
      </div>
    </div>
  );
};
