import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { devicesAPI } from '../../services/api';
import type { Device } from '../../types/farming';
import { ValveControlHelp } from './shared/ValveControlHelp';

interface Props {
    device: Device;
    onUpdate?: () => void;
    onError?: (message: string) => void;
}

function getApiMessage(error: any): string {
    return error?.response?.data?.message || error?.response?.data?.error || 'Failed to cancel queued open';
}

export default function ValveCancelButton({ device, onUpdate, onError }: Props) {
    const { t } = useTranslation('devices');
    const { t: tValves } = useTranslation('valves');
    // D04 (owner decision 2026-10-18), verbatim, as the button's description and in a help button.
    const helpId = useId();
    const helpText = tValves('cancelHelp', { defaultValue: 'Cancel deletes the pending command. It does not close a valve that is already open.' });
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
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    disabled={busy}
                    onClick={handleCancel}
                    aria-describedby={helpId}
                    className="px-3 py-1 rounded bg-red-600 text-white disabled:opacity-50"
                >
                    {busy
                        ? t('stregaValve.cancelling', { defaultValue: 'Cancelling...' })
                        : t('stregaValve.cancelQueuedOpen', { defaultValue: 'Cancel queued open' })}
                </button>
                <span id={helpId} className="sr-only">{helpText}</span>
                <ValveControlHelp label={tValves('cancelHelpLabel', { defaultValue: 'About cancel' })}>{helpText}</ValveControlHelp>
            </div>
            {error && <p className="text-[var(--error-text)] text-xs">{error}</p>}
        </div>
    );
}
