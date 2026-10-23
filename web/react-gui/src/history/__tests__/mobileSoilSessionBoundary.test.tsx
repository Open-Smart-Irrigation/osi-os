import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sessionIdentity: { sessionEpoch: 1, principalId: 'old-user' },
  requests: [] as Array<{ cardId: string; signal?: AbortSignal; resolve: (value: any) => void; reject: (error: unknown) => void }>,
}));
vi.hoisted(() => {
  if (typeof window !== 'undefined' && !window.matchMedia) window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, media: '', onchange: null })) as typeof window.matchMedia;
  if (typeof HTMLCanvasElement !== 'undefined') HTMLCanvasElement.prototype.getContext = (() => ({ clearRect() {}, fillRect() {}, measureText: () => ({ width: 0 }), setTransform() {}, resetTransform() {}, save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, rect() {}, clip() {}, scale() {}, translate() {}, rotate() {}, arc() {}, fillText() {}, strokeText() {}, setLineDash() {}, createLinearGradient: () => ({ addColorStop() {} }) })) as any;
  if (typeof globalThis.Path2D === 'undefined') (globalThis as any).Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} rect() {} arc() {} };
});

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => state }));
vi.mock('../../services/api', () => ({
  historyAPI: {
    getZoneCardData: vi.fn((_zoneId: number, cardId: string, request: { signal?: AbortSignal }) => new Promise((resolve, reject) => state.requests.push({ cardId, signal: request.signal, resolve, reject }))),
    getGatewayCardData: vi.fn(),
  },
}));
vi.mock('@osi/history-uplot', async () => {
  const actual = await vi.importActual<any>('@osi/history-uplot');
  return {
    ...actual,
    mountUplot: () => ({ setData() {}, setViewport() {}, getViewport: () => ({ from: 0, to: 86_400_000 }), getPlotRect: () => new DOMRect(0, 0, 320, 180), resize() {}, destroy() {} }),
  };
});

import { MobileSoilUplotHistory } from '../../components/history/mobile/MobileSoilUplotHistory';

function response(label: string) {
  return { cardId: 'soil', cardType: 'soil', view: 'line-chart', range: { label: '24h', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', timezone: 'UTC' }, aggregation: { level: '15m', pointCount: 1, coveragePct: 100 }, limits: { maxPointsPerSeries: 10, truncated: false }, series: [{ id: label, label, unit: 'kPa', points: [{ t: '2026-01-01T00:00:00Z', value: 12, coverageConfidence: 'configured' }] }], freshness: { dataAsOf: null, syncState: 'synced' } };
}

function view(cardId = 'soil') { return <MobileSoilUplotHistory scope={{ type: 'zone', zoneId: 7 }} cardId={cardId} sourceKey="old-source" />; }

describe('mobile soil host session boundary', () => {
  beforeEach(() => { state.sessionIdentity = { sessionEpoch: 1, principalId: 'old-user' }; state.requests.length = 0; });
  it('drops an old session response and renders only the new session', async () => {
    const rendered = render(view());
    await waitFor(() => expect(state.requests.some((request) => request.cardId === 'soil')).toBe(true));
    const oldRequest = state.requests.find((request) => request.cardId === 'soil')!;
    state.sessionIdentity = { sessionEpoch: 2, principalId: 'new-user' };
    rendered.rerender(view('new-soil'));
    await waitFor(() => expect(state.requests.some((request) => request.cardId === 'new-soil')).toBe(true));
    expect(screen.queryByText('Old probe')).not.toBeInTheDocument();
    expect(oldRequest.signal?.aborted).toBe(true);
    await act(async () => oldRequest.resolve(response('Old probe')));
    expect(screen.queryByText('Old probe')).not.toBeInTheDocument();
    const newRequest = state.requests.find((request) => request.cardId === 'new-soil')!;
    await act(async () => newRequest.resolve(response('New probe')));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /New probe/ })).toBeInTheDocument());
  });
});

describe('mobile soil host visible interval', () => {
  beforeEach(() => { state.sessionIdentity = { sessionEpoch: 1, principalId: 'old-user' }; state.requests.length = 0; });
  it('lets the host read the interval the chart shows and releases the reader on unmount', async () => {
    const reader: { current: (() => { from: number; to: number }) | null } = { current: null };
    const rendered = render(<MobileSoilUplotHistory scope={{ type: 'zone', zoneId: 7 }} cardId="soil" sourceKey={null} visibleIntervalReaderRef={reader} />);
    await waitFor(() => expect(reader.current).not.toBeNull());
    const initial = reader.current!();
    expect(initial.to - initial.from).toBe(24 * 60 * 60 * 1000);
    await act(async () => { screen.getByRole('button', { name: 'mobileUplot.ranges.week' }).click(); });
    const week = reader.current!();
    expect(week.to - week.from).toBe(7 * 24 * 60 * 60 * 1000);
    expect(week.to).toBe(initial.to);
    rendered.unmount();
    expect(reader.current).toBeNull();
  });
});
