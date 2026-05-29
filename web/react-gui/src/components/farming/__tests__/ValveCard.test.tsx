import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

import { StregaValveCard } from '../StregaValveCard';
import { devicesAPI } from '../../../services/api';
import type { IrrigationActuation } from '../../../services/api';
import type { Device } from '../../../types/farming';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
        tc: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
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

function actuationFixture(overrides: Partial<IrrigationActuation> = {}): IrrigationActuation {
    return {
        expectationId: 'exp-1',
        deviceEui: mockDevice.deveui,
        deviceName: mockDevice.name,
        zoneId: 1,
        zoneName: 'North block',
        commandId: 'cmd-1',
        commandedAt: '2026-05-29T10:00:00Z',
        commandedDurationSeconds: 600,
        expectedCloseAt: '2026-05-29T10:10:00Z',
        observedOpenAt: null,
        observedCloseAt: null,
        estimatedGrossLiters: null,
        flowRateLpm: null,
        reconciliationState: 'PENDING_OBSERVATION',
        cancelReason: null,
        commandResult: null,
        commandResultDetail: null,
        commandAppliedAt: null,
        status: 'PENDING_OPEN',
        ...overrides,
    };
}

function renderCard(overrides: Partial<Device> = {}, props: Record<string, unknown> = {}) {
    const onUpdate = vi.fn();
    const onRemove = vi.fn();
    const todayLiters = { value: 42.5, source: 'estimated_duration_flow_rate' as const };
    const device = { ...mockDevice, ...overrides, type_id: mockDevice.type_id } as Device;
    const result = render(
        React.createElement(StregaValveCard, { device, onUpdate, onRemove, todayLiters, ...props }),
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

    it('does not render cancel control without an active actuation expectation', async () => {
        renderCard({ current_state: 'OPEN' });
        expect(screen.queryByRole('button', { name: /cancel queued open/i })).not.toBeInTheDocument();
    });

    it('calls cancelIrrigation API for an active queued open without sending CLOSE', async () => {
        renderCard({
            current_state: 'OPEN',
            activeValveActuation: {
                expectationId: 'vae-1',
                reconciliationState: 'PENDING_OBSERVATION',
            },
        } as Partial<Device>);
        const cancelBtn = await screen.findByRole('button', { name: /cancel queued open/i });
        fireEvent.click(cancelBtn);
        await waitFor(() => {
            expect(devicesAPI.cancelIrrigation).toHaveBeenCalledWith(mockDevice.deveui);
        });
        expect(devicesAPI.controlValve).not.toHaveBeenCalledWith(mockDevice.deveui, {
            action: 'CLOSE',
        });
    });

    it('displays estimated liters with label', async () => {
        renderCard();
        expect(await screen.findByText(/42.5 L/)).toBeInTheDocument();
        expect(screen.getByText(/Estimated/)).toBeInTheDocument();
    });

    it('shows persistent queued feedback from a pending VAE row', async () => {
        renderCard({}, {
            irrigationActuations: [
                actuationFixture({
                    status: 'PENDING_OPEN',
                    commandedDurationSeconds: 900,
                    expectedCloseAt: '2026-05-29T10:15:00Z',
                }),
            ],
        });

        expect(await screen.findByText(/Open queued/i)).toBeInTheDocument();
        expect(screen.getByText(/waiting for valve uplink/i)).toBeInTheDocument();
        expect(document.body.textContent).toMatch(/15 min/);
    });

    it('shows running feedback with the expected close time once the VAE row is observed open', async () => {
        const expectedCloseLabel = new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/New_York',
        }).format(new Date('2026-05-29T10:15:00Z'));

        renderCard({}, {
            timeZone: 'America/New_York',
            irrigationActuations: [
                actuationFixture({
                    status: 'RUNNING',
                    observedOpenAt: '2026-05-29T10:01:00Z',
                    expectedCloseAt: '2026-05-29T10:15:00Z',
                }),
            ],
        });

        expect(await screen.findByText(new RegExp(`OPEN .* closes at ${expectedCloseLabel}`))).toBeInTheDocument();
    });

    it('shows closed feedback once the VAE row has observed close', async () => {
        renderCard({}, {
            irrigationActuations: [
                actuationFixture({
                    status: 'COMPLETED',
                    observedOpenAt: '2026-05-29T10:01:00Z',
                    observedCloseAt: '2026-05-29T10:09:00Z',
                }),
            ],
        });

        expect(await screen.findByText(/Closed at/i)).toBeInTheDocument();
    });
});
