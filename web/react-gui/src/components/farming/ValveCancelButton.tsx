import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { devicesAPI } from '../../services/api';
import type { Device } from '../../types/farming';

interface Props {
    device: Device;
    onUpdate?: () => void;
    onError?: (message: string) => void;
}

function getApiMessage(error: any): string {
    return error?.response?.data?.message || error?.response?.data?.error || 'Failed to cancel irrigation';
}

export default function ValveCancelButton({ device, onUpdate, onError }: Props) {
    const { t } = useTranslation('devices');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const handleCancel = async () => {
        setBusy(true);
        setError(null);
        try {
            await devicesAPI.cancelIrrigation(device.deveui);
            onUpdate?.();
        } catch (err: any) {
            const message = getApiMessage(err);
            setError(message);
            onError?.(message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="space-y-1">
            <button
                type="button"
                disabled={busy}
                onClick={handleCancel}
                className="px-3 py-1 rounded bg-red-600 text-white disabled:opacity-50"
            >
                {busy
                    ? t('stregaValve.cancelling', { defaultValue: 'Cancelling…' })
                    : t('stregaValve.cancelIrrigation', { defaultValue: 'Cancel irrigation' })}
            </button>
            {error && <p className="text-[var(--error-text)] text-xs">{error}</p>}
        </div>
    );
}
