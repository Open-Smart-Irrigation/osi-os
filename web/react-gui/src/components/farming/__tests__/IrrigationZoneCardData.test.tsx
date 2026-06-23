import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrrigationZoneCard } from '../IrrigationZoneCard';
import type { IrrigationZone } from '../../../types/farming';
import { isDesktopBrowser } from '../../../utils/isDesktopBrowser';

vi.mock('../../../services/api', () => ({
  dendroAnalyticsAPI: {
    getZoneRecommendations: vi.fn().mockResolvedValue([]),
  },
  environmentAPI: {
    getSummary: vi.fn().mockResolvedValue(null),
  },
  irrigationZonesAPI: {
    delete: vi.fn().mockResolvedValue(undefined),
    removeDevice: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../utils/isDesktopBrowser', () => ({
  isDesktopBrowser: vi.fn(() => false),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      if (typeof options === 'string') return options;
      if (key === 'zone.deviceCount') return '2 devices';
      if (key === 'zone.assignDevice') return 'Assign Device';
      if (key === 'zone.deleteZone') return 'Delete Zone';
      return key;
    },
  }),
}));

const zone = {
  id: 12,
  name: 'Zone B',
  device_count: 2,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  schedule: null,
} as IrrigationZone;

function renderCard() {
  render(
    <MemoryRouter>
      <IrrigationZoneCard
        zone={zone}
        devices={[]}
        unassignedDevices={[]}
        onUpdate={vi.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(isDesktopBrowser).mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IrrigationZoneCard Data entry', () => {
  it('renders a mobile Data link to the zone fullscreen history view', () => {
    renderCard();

    const dataLink = screen.getByRole('link', { name: /data/i });
    expect(dataLink).toHaveAttribute('href', '/history/zones/12');
    expect(dataLink).toHaveClass(
      'touch-target',
      'bg-[var(--success-border)]',
      'hover:bg-green-700',
      'text-white',
      'px-4',
      'py-2',
      'rounded-lg',
      'text-sm',
      'font-semibold',
      'transition-colors',
      'inline-flex',
      'items-center',
      'justify-center',
    );
  });

  it('hides the zone-card Data link on desktop browsers', () => {
    vi.mocked(isDesktopBrowser).mockReturnValue(true);
    renderCard();

    expect(screen.queryByRole('link', { name: /data/i })).not.toBeInTheDocument();
  });
});
