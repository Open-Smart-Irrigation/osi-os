import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HistoryDetailHeader } from '../mobile/HistoryDetailHeader';
import type { HistoryCardSummary } from '../../../history/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const cardFixture: HistoryCardSummary = {
  cardId: 'zone-1:environment:merged',
  cardType: 'environment',
  scope: 'zone',
  title: 'Environment',
  view: 'line-chart',
  icon: null,
  sortOrder: 0,
};

describe('HistoryDetailHeader', () => {
  it('closes the settings menu on Escape', () => {
    const onSettingsToggle = vi.fn();
    render(
      <HistoryDetailHeader
        zoneName="Zone A"
        card={cardFixture}
        settingsOpen
        onSettingsToggle={onSettingsToggle}
        onResetRange={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onSettingsToggle).toHaveBeenCalledTimes(1);
  });

  it('closes the settings menu when tapping the backdrop', () => {
    const onSettingsToggle = vi.fn();
    render(
      <HistoryDetailHeader
        zoneName="Zone A"
        card={cardFixture}
        settingsOpen
        onSettingsToggle={onSettingsToggle}
        onResetRange={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('history-settings-backdrop'));
    expect(onSettingsToggle).toHaveBeenCalledTimes(1);
  });
});
