import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

import { StregaValveCard } from '../StregaValveCard';
import { devicesAPI } from '../../../services/api';
import type { IrrigationActuation } from '../../../services/api';
import type { Device, ValveSummary } from '../../../types/farming';

const { translateForTest } = vi.hoisted(() => {
    const testTranslations: Record<string, string> = {
        'stregaValve.actuationFeedback.closed': 'Translated closed',
        'stregaValve.actuationFeedback.closedAt': 'Translated closed at {{time}}',
        'stregaValve.actuationFeedback.open': 'Translated open',
        'stregaValve.actuationFeedback.openClosesAt': 'Translated open closes at {{time}}',
        'stregaValve.actuationFeedback.openQueued': 'Translated queued',
        'stregaValve.actuationFeedback.waitingForUplink': 'Translated waiting {{minutes}} min',
    };

    return {
        translateForTest: (key: string, options?: { defaultValue?: string; [key: string]: unknown }): string => {
            const template = testTranslations[key] ?? options?.defaultValue ?? key;
            return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
        },
    };
});

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: translateForTest,
        tc: translateForTest,
        i18n: { language: 'en' },
    }),
}));

vi.mock('../../../services/api', () => ({
    devicesAPI: {
        controlValve: vi.fn().mockResolvedValue(undefined),
        cancelIrrigation: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
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
    dendro_baseline_pending: 0,
    last_seen: '2026-05-17T12:00:00Z',
} as unknown as Device;

function makeValveSummary(overrides: Partial<ValveSummary> = {}): ValveSummary {
    return {
        deviceEui: mockDevice.deveui,
        name: mockDevice.name,
        zoneId: null,
        zoneName: null,
        zoneUuid: null,
        timezone: 'UTC',
        currentState: 'CLOSED',
        targetState: null,
        stregaGeneration: 'GEN1',
        flowRateLpm: null,
        flowRateSource: null,
        defaultOpenMinutes: null,
        schedulerStatus: 'ACTIVE',
        skipTodayDate: null,
        lastUplinkAt: null,
        activeActuation: null,
        recentStaleState: null,
        nextRun: null,
        scheduleCount: 0,
        pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
        lastClockSyncAckedAt: null,
        enclosureTemperatureC: null,
        enclosureHumidityPct: null,
        enclosureMeasuredAt: null,
        ...overrides,
    };
}

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
        trigger: null,
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
    it('does not move water on a single tap — Open must be confirmed', async () => {
        // osi-os#171: the Valve control panel requires an explicit confirm
        // (ValveOpenDialog) before opening. This card went straight to controlValve, so the
        // same valve was laxer here than on the panel. First tap arms only.
        renderCard();
        fireEvent.click(await screen.findByText(/5 min/));
        expect(devicesAPI.controlValve).not.toHaveBeenCalled();
    });

    it('sends timed OPEN with duration_seconds once confirmed', async () => {
        const { onUpdate } = renderCard();
        fireEvent.click(await screen.findByText(/5 min/));           // arm
        fireEvent.click(await screen.findByText(/Confirm/i));        // confirm
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

        expect(await screen.findByText(/Translated queued/i)).toBeInTheDocument();
        expect(screen.getByText(/Translated waiting/i)).toBeInTheDocument();
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

        expect(await screen.findByText(`Translated open closes at ${expectedCloseLabel}`)).toBeInTheDocument();
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

        const expectedCloseLabel = new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date('2026-05-29T10:09:00Z'));
        expect(await screen.findByText(`Translated closed at ${expectedCloseLabel}`)).toBeInTheDocument();
    });

    it('shows the labelled enclosure reading when the valve-list row carries one', async () => {
        renderCard({}, {
            valve: makeValveSummary({ enclosureTemperatureC: 21.5, enclosureHumidityPct: 48.2 }),
        });
        expect(await screen.findByText('21.5 °C · 48.2 % RH')).toBeInTheDocument();
    });

    it('renders a measured zero enclosure reading rather than treating it as missing', async () => {
        renderCard({}, {
            valve: makeValveSummary({ enclosureTemperatureC: 0, enclosureHumidityPct: 0 }),
        });
        expect(await screen.findByText('0 °C · 0 % RH')).toBeInTheDocument();
    });

    it('shows "no reading yet" for a GEN1 valve whose list row has no enclosure values', async () => {
        renderCard({}, {
            valve: makeValveSummary({ stregaGeneration: 'GEN1', enclosureTemperatureC: null, enclosureHumidityPct: null }),
        });
        expect(await screen.findByText('no reading yet')).toBeInTheDocument();
    });

    it('shows "not measured on Gen2" for a GEN2 valve, even if the row somehow carries a value', async () => {
        renderCard({}, {
            valve: makeValveSummary({ stregaGeneration: 'GEN2', enclosureTemperatureC: 21.5, enclosureHumidityPct: 48 }),
        });
        expect(await screen.findByText('not measured on Gen2')).toBeInTheDocument();
        expect(screen.queryByText('21.5 °C · 48 % RH')).not.toBeInTheDocument();
        expect(screen.queryByText('no reading yet')).not.toBeInTheDocument();
    });

    it('renders nothing for the enclosure row when no valve-list row exists for this device', async () => {
        const { container } = renderCard();
        await screen.findByText(/5 min/); // wait for the card to finish its initial render
        expect(container.textContent).not.toMatch(/Enclosure|no reading yet|not measured on Gen2|°C/);
    });

    // C-1 (Bovey final fix wave review): the confirm-remove flow's own devicesAPI.remove
    // call must be gated on removeContext, not unconditional -- the zone-card placement
    // (removeContext="zone") relies on the caller's onRemove to do the actual
    // irrigationZonesAPI.removeDevice zone-detach; it must never also unclaim the device
    // from the whole farm.
    it('removeContext="zone": confirming remove only calls onRemove, never devicesAPI.remove', async () => {
        const { onRemove } = renderCard({}, { removeContext: 'zone' });
        fireEvent.click(await screen.findByTitle('Remove device'));
        fireEvent.click(await screen.findByText('stregaValve.yesRemove'));
        await waitFor(() => {
            expect(onRemove).toHaveBeenCalled();
        });
        expect(devicesAPI.remove).not.toHaveBeenCalled();
    });

    it('default removeContext ("farm"): confirming remove calls devicesAPI.remove, then onRemove', async () => {
        const { onRemove } = renderCard();
        fireEvent.click(await screen.findByTitle('Remove device'));
        fireEvent.click(await screen.findByText('stregaValve.yesRemove'));
        await waitFor(() => {
            expect(devicesAPI.remove).toHaveBeenCalledWith(mockDevice.deveui);
        });
        expect(onRemove).toHaveBeenCalled();
    });
});
