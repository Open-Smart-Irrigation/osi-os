// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MetricAcrossZonesPicker } from '../MetricAcrossZonesPicker';
import type { AnalysisCatalogEntry } from '../../../analysis/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('starts collapsed and puts diagnostics behind a second disclosure', () => {
  const channel = (channelKey: string): AnalysisCatalogEntry => ({
    seriesId: channelKey, channelKey, displayName: channelKey, sourceKind: 'device',
    availability: 'available', zoneId: 1, zoneName: 'North', hubEui: null,
    cardType: 'soil', sourceKey: 'source', deviceName: null, depthCm: null, unit: null,
  });
  const { container } = render(<MetricAcrossZonesPicker channels={['swt_1', 'adc_ch0v', 'unknown_metric'].map(channel)} onApply={vi.fn()} />);
  const disclosures = container.querySelectorAll('details');
  expect(disclosures).toHaveLength(2);
  expect(disclosures[0]).not.toHaveAttribute('open');
  expect(disclosures[1]).not.toHaveAttribute('open');
  expect(screen.getByRole('button', { name: 'swt_1' }).closest('details')).toBe(disclosures[0]);
  expect(screen.getByRole('button', { name: 'adc_ch0v' }).closest('details')).toBe(disclosures[1]);
  expect(screen.getByRole('button', { name: 'unknown_metric' }).closest('details')).toBe(disclosures[1]);
});
