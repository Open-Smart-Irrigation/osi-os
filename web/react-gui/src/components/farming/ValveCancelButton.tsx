import { useState } from 'react';
import { devicesAPI } from '../../services/api';
import type { Device } from '../../types/farming';

interface Props {
    device: Device;
}

export default function ValveCancelButton({ device }: Props) {
    const [busy, setBusy] = useState(false);
    const handleCancel = async () => {
        setBusy(true);
        try {
            await devicesAPI.cancelIrrigation(device.deveui);
        } finally {
            setBusy(false);
        }
    };
    return (
        <button
            type="button"
            disabled={busy}
            onClick={handleCancel}
            className="px-3 py-1 rounded bg-red-600 text-white disabled:opacity-50"
        >
            {busy ? 'Cancelling…' : 'Cancel irrigation'}
        </button>
    );
}
