import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReadOnlyNotice } from '../ReadOnlyNotice';

// Maintainer decision 3(c) (S6): eighteen sites hid write controls with zero
// explanation. ReadOnlyNotice (built in T7) is the single per-surface
// explanation this task mounts once per qualifying page — never once per
// hidden control. These tests prove the component itself behaves: a stable,
// polite status (not an alert, since read-only is an expected state, not a
// failure) using the `info` tone so `warn` keeps meaning "you cannot write".
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'readOnly.farm': 'You have read-only access to this farm.',
      'readOnly.section': 'You have read-only access to this section.',
    })[key] ?? key,
  }),
}));

describe('ReadOnlyNotice', () => {
  it('renders as a polite status, not an alert — read-only is a stable state', () => {
    render(<ReadOnlyNotice scope="farm" />);
    const el = screen.getByRole('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
  });

  it('uses the info tone, so amber keeps meaning "you cannot write"', () => {
    const { container } = render(<ReadOnlyNotice scope="farm" />);
    const el = container.firstElementChild!;
    expect(el.className).toContain('var(--info-bg)');
    expect(el.className).not.toContain('var(--warn-bg)');
  });

  it('resolves common:readOnly.farm for scope="farm"', () => {
    render(<ReadOnlyNotice scope="farm" />);
    expect(screen.getByText('You have read-only access to this farm.')).toBeInTheDocument();
  });

  it('resolves common:readOnly.section for scope="section"', () => {
    render(<ReadOnlyNotice scope="section" />);
    expect(screen.getByText('You have read-only access to this section.')).toBeInTheDocument();
  });
});
