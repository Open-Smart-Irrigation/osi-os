import '@testing-library/jest-dom/vitest';
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      const parts = Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',');
      return `${key}[${parts}]`;
    },
  }),
}));

import { JournalMarkerLane, type JournalMarkerLaneMarker } from '../JournalMarkerLane';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SEASON_MS = 180 * DAY_MS;
const WIDTH_PX = 320;

function marker(overrides: Partial<JournalMarkerLaneMarker> = {}): JournalMarkerLaneMarker {
  return {
    entryUuid: 'e1',
    activityCode: 'irrigation',
    occurredAtMs: DAY_MS / 2,
    note: null,
    ...overrides,
  };
}

function renderLane(props: Partial<React.ComponentProps<typeof JournalMarkerLane>> = {}) {
  return render(
    <JournalMarkerLane
      markers={[]}
      fromMs={0}
      toMs={DAY_MS}
      widthPx={WIDTH_PX}
      {...props}
    />,
  );
}

function markerButtons() {
  return screen.queryAllByRole('button').filter((el) => el.hasAttribute('data-marker-kind'));
}

describe('JournalMarkerLane', () => {
  it('renders the landmark region with zero events and no marker buttons', () => {
    renderLane({ markers: [] });

    expect(screen.getByTestId('journal-marker-lane')).toBeInTheDocument();
    expect(markerButtons()).toHaveLength(0);
  });

  it('shows a loading indicator and no markers while loading', () => {
    renderLane({ markers: [], loading: true });

    expect(screen.getByTestId('journal-marker-lane-loading')).toBeInTheDocument();
    expect(markerButtons()).toHaveLength(0);
  });

  it('shows an error state with a retry action', () => {
    const onRetry = vi.fn();
    renderLane({ markers: [], error: new Error('offline'), onRetry });

    const retryButton = screen.getByTestId('journal-marker-lane-retry');
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders exactly one marker for a single event', () => {
    renderLane({ markers: [marker({ entryUuid: 'only' })] });

    const buttons = markerButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('data-marker-kind', 'single');
  });

  it('gives every marker a hit target of at least 48x48 px', () => {
    renderLane({ markers: [marker({ entryUuid: 'only' })] });

    const [button] = markerButtons();
    expect(button.style.width).toBe('48px');
    expect(button.style.height).toBe('48px');
  });

  it('encodes different activities with different shape AND icon AND color, not color alone', () => {
    renderLane({
      markers: [
        marker({ entryUuid: 'irr', activityCode: 'irrigation', occurredAtMs: 0 }),
        marker({ entryUuid: 'harv', activityCode: 'harvest', occurredAtMs: DAY_MS }),
      ],
    });

    const buttons = markerButtons();
    expect(buttons).toHaveLength(2);
    const [a, b] = buttons;

    expect(a.getAttribute('data-shape')).not.toBe(b.getAttribute('data-shape'));
    expect(a.getAttribute('data-activity')).not.toBe(b.getAttribute('data-activity'));
    expect(a.className).not.toBe(b.className);

    const iconA = within(a).getByText((_, el) => el?.getAttribute('aria-hidden') === 'true');
    const iconB = within(b).getByText((_, el) => el?.getAttribute('aria-hidden') === 'true');
    expect(iconA.textContent).not.toBe(iconB.textContent);
  });

  it('falls back to a distinct style for unrecognized activity codes', () => {
    renderLane({ markers: [marker({ activityCode: 'totally_unknown_activity' })] });

    const [button] = markerButtons();
    expect(button.getAttribute('data-shape')).toBeTruthy();
    expect(button.getAttribute('data-activity')).toBe('totally_unknown_activity');
  });

  it('clusters 50 densely-packed events into fewer than 50 rendered targets without losing any', () => {
    const markers = Array.from({ length: 50 }, (_, i) => marker({
      entryUuid: `e${i}`,
      occurredAtMs: i * 60_000, // one minute apart, tightly packed at 320px over 24h
    }));
    renderLane({ markers });

    const buttons = markerButtons();
    expect(buttons.length).toBeLessThan(50);
    const totalCounted = buttons.reduce((sum, btn) => sum + Number(btn.getAttribute('data-count')), 0);
    expect(totalCounted).toBe(50);
  });

  it('clusters 500 events across a season window without losing any and without exploding DOM size', () => {
    const markers = Array.from({ length: 500 }, (_, i) => marker({
      entryUuid: `e${i}`,
      occurredAtMs: (i / 500) * SEASON_MS,
    }));
    renderLane({ markers, fromMs: 0, toMs: SEASON_MS });

    const buttons = markerButtons();
    expect(buttons.length).toBeLessThan(50);
    const totalCounted = buttons.reduce((sum, btn) => sum + Number(btn.getAttribute('data-count')), 0);
    expect(totalCounted).toBe(500);
  });

  it('labels a cluster button with its member count', () => {
    const markers = Array.from({ length: 12 }, (_, i) => marker({ entryUuid: `e${i}`, occurredAtMs: i * 1000 }));
    renderLane({ markers });

    const [button] = markerButtons();
    expect(button).toHaveAttribute('data-marker-kind', 'cluster');
    expect(button).toHaveAttribute('data-count', '12');
    expect(button.getAttribute('aria-label')).toContain('count=12');
  });

  it('moves focus between markers with ArrowRight and ArrowLeft', () => {
    renderLane({
      markers: [
        marker({ entryUuid: 'first', occurredAtMs: 0 }),
        marker({ entryUuid: 'second', occurredAtMs: DAY_MS }),
      ],
    });

    const [first, second] = markerButtons();
    first.focus();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
  });

  it('opens the details bottom sheet on Enter and closes it on Escape', () => {
    renderLane({ markers: [marker({ entryUuid: 'only', note: 'Checked drip lines' })] });

    const [button] = markerButtons();
    fireEvent.keyDown(button, { key: 'Enter' });

    const sheet = screen.getByRole('dialog');
    expect(sheet).toBeInTheDocument();
    expect(within(sheet).getByText(/Checked drip lines/)).toBeInTheDocument();

    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the details bottom sheet on click and shows a no-note placeholder when note is absent', () => {
    renderLane({ markers: [marker({ entryUuid: 'only', note: null })] });

    fireEvent.click(markerButtons()[0]);

    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText('markers.sheet.noNote')).toBeInTheDocument();
  });

  it('lists every member entry of a cluster inside the bottom sheet', () => {
    const markers = [
      marker({ entryUuid: 'e1', activityCode: 'irrigation', occurredAtMs: 0, note: 'first' }),
      marker({ entryUuid: 'e2', activityCode: 'harvest', occurredAtMs: 1000, note: 'second' }),
    ];
    renderLane({ markers });

    fireEvent.click(markerButtons()[0]);
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText(/first/)).toBeInTheDocument();
    expect(within(sheet).getByText(/second/)).toBeInTheDocument();
  });

  it('closes the sheet via the explicit close button', () => {
    renderLane({ markers: [marker({ entryUuid: 'only' })] });

    fireEvent.click(markerButtons()[0]);
    fireEvent.click(screen.getByTestId('journal-marker-sheet-close'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders a filter chip per distinct activity and hides filtered-out markers', () => {
    renderLane({
      markers: [
        marker({ entryUuid: 'irr', activityCode: 'irrigation', occurredAtMs: 0 }),
        marker({ entryUuid: 'harv', activityCode: 'harvest', occurredAtMs: DAY_MS }),
      ],
    });

    expect(markerButtons()).toHaveLength(2);

    fireEvent.click(screen.getByTestId('journal-marker-filter-harvest'));

    const remaining = markerButtons();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].getAttribute('data-activity')).toBe('irrigation');
  });

  it('does not render filter chips when every visible marker shares one activity', () => {
    renderLane({ markers: [marker({ activityCode: 'irrigation' })] });

    expect(screen.queryByTestId(/journal-marker-filter-/)).not.toBeInTheDocument();
  });
});
