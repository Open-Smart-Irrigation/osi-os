import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageSwitcher } from '../LanguageSwitcher';

const i18nMock = vi.hoisted(() => ({
  changeLanguage: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      language: 'en-US',
      changeLanguage: i18nMock.changeLanguage,
    },
  }),
}));

vi.mock('../../i18n/config', () => ({
  SUPPORTED_LANGUAGES: [
    { code: 'en', label: 'English' },
    { code: 'de-CH', label: 'Deutsch' },
    { code: 'fr', label: 'Français' },
  ],
}));

afterEach(() => {
  cleanup();
  i18nMock.changeLanguage.mockClear();
});

describe('LanguageSwitcher', () => {
  it('uses the same menu-button shape as the dashboard header controls', () => {
    render(<LanguageSwitcher triggerClassName="px-6 py-3 text-lg w-full" />);

    const trigger = screen.getByRole('button', { name: 'English' });
    expect(trigger).toHaveClass('w-full');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Deutsch' }));

    expect(i18nMock.changeLanguage).toHaveBeenCalledWith('de-CH');
  });
});
