import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

import { StregaValveCard } from '../StregaValveCard';
import { devicesAPI } from '../../../services/api';
import type { Device } from '../../../types/farming';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
        tc: (key: string) => key,
        i18n: { language: 'en' },
    }),
}));

vi.mock('../../../services/api', () => ({
    devicesAPI: {
        controlValve: vi.fn().mockResolvedValue(undefined),
        cancelIrrigation: vi.fn().mockResolvedValue(undefined),
    },
    valveAPI: {
        getTodayLiters: vi.fn().mockResolvedValue({ liters: null, source: 'unknown' }),
    },
}));

const mockDevice: Device = {
    id: 1,
    deveui: '0016C001F151B1D6',
    name: 'Valve White',
    type_id: 'STREGA_VALVE',
    current_state: 'CLOSED',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    irrigation_zone_id: null,
    is_claimed: true,
    claimed_by_username: 'test',
    claimed_by_user_uuid: 'uuid-1',
    strega_model: 'STREGA_VALVE',
    dendro_ratio_at_retracted: null,
    dendro_ratio_at_extended: null,
    dendro_baseline_pending: false,
    last_seen: '2026-05-17T12:00:00Z',
};

function renderCard(overrides: Partial<Device> = {}) {
    const onUpdate = vi.fn();
    const onRemove = vi.fn();
    const todayLiters = { value: 42.5, source: 'estimated_duration_flow_rate' as const };
    const device = { ...mockDevice, ...overrides, type_id: mockDevice.type_id } as Device;
    const result = render(
        React.createElement(StregaValveCard, { device, onUpdate, onRemove, todayLiters }),
    );
    return { ...result, onUpdate, onRemove, todayLiters };
}

describe('StregaValveCard', () => {
    it('sends timed OPEN with duration_seconds', async () => {
        const { onUpdate } = renderCard();
        const openBtn = await screen.findByText(/5 min/);
        fireEvent.click(openBtn);
        await waitFor(() => {
            expect(devicesAPI.controlValve).toHaveBeenCalledWith(mockDevice.deveui, {
                action: 'OPEN_FOR_DURATION',
                duration_seconds: 300,
            });
        });
        expect(onUpdate).toHaveBeenCalled();
    });

    it('sends CLOSE without duration', async () => {
        renderCard({ current_state: 'OPEN' });
        const closeBtn = await screen.findByRole('button', { name: /closed/ });
        fireEvent.click(closeBtn);
        await waitFor(() => {
            expect(devicesAPI.controlValve).toHaveBeenCalledWith(mockDevice.deveui, {
                action: 'CLOSE',
            });
        });
    });

    it('renders cancel button when valve is OPEN', async () => {
        renderCard({ current_state: 'OPEN' });
        expect(await screen.findByText('stregaValve.cancelIrrigation')).toBeInTheDocument();
    });

    it('calls cancelIrrigation API on cancel click', async () => {
        renderCard({ current_state: 'OPEN' });
        const cancelBtn = await screen.findByText('stregaValve.cancelIrrigation');
        fireEvent.click(cancelBtn);
        await waitFor(() => {
            expect(devicesAPI.cancelIrrigation).toHaveBeenCalledWith(mockDevice.deveui);
        });
    });

    it('displays estimated liters with label', async () => {
        renderCard();
        expect(await screen.findByText(/42.5 L/)).toBeInTheDocument();
        expect(screen.getByText(/Estimated/)).toBeInTheDocument();
    });
});
