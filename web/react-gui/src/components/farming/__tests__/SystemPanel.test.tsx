// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SystemPanel } from '../SystemPanel';

// t() returns the key itself, matching this codebase's convention (see
// DraginoTempCard.test.tsx). A dedicated real-i18n test covers actual
// translated copy (SystemPanel.frLocale.test.tsx).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const apiMocks = vi.hoisted(() => ({
  getStats: vi.fn(),
  setFan: vi.fn(),
  reboot: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  systemAPI: {
    getStats: apiMocks.getStats,
    setFan: apiMocks.setFan,
    reboot: apiMocks.reboot,
  },
}));

const scopeMocks = vi.hoisted(() => ({
  scopeState: {
    loading: false,
    resolved: true,
    isScoped: false,
    role: 'admin' as 'admin' | 'researcher' | 'viewer',
    canWrite: true,
    isAdmin: true,
    zoneWritable: vi.fn(() => true),
    profile: null,
    error: null as string | null,
    retry: vi.fn(),
  },
}));

vi.mock('../../../contexts/ScopeContext', () => ({
  useScope: () => scopeMocks.scopeState,
}));

const baseStats = {
  cpu_temp_c: 42.3,
  mem_total_mb: 2000,
  mem_used_mb: 512,
  mem_free_mb: 1488,
  mem_percent: 25,
  load_1: 0.12,
  load_5: 0.2,
  load_15: 0.3,
  cpu_count: 4,
  fan_available: true,
  fan_mode: 'pwm' as const,
  fan_value: 0,
  fan_max: 255,
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getStats.mockResolvedValue(baseStats);
  apiMocks.setFan.mockResolvedValue(undefined);
  apiMocks.reboot.mockResolvedValue(undefined);
  Object.assign(scopeMocks.scopeState, {
    loading: false,
    resolved: true,
    isScoped: false,
    role: 'admin',
    canWrite: true,
    isAdmin: true,
    error: null,
  });
});

afterEach(() => {
  cleanup();
});

async function renderPanel() {
  render(<SystemPanel />);
  // Wait for the async getStats() fetch (mount effect) to resolve and the
  // stats grid, including the Fan Control card, to appear.
  return screen.findByText('systemPanel.fanControl');
}

describe('SystemPanel role gating (F20)', () => {
  it.each([
    ['viewer', false, false],
    ['researcher', false, false],
    ['admin', false, false],
    ['viewer', true, true],
    ['researcher', true, true],
    ['admin', true, false],
  ] as const)(
    'role=%s, scoped=%s -> reboot/fan disabled=%s',
    async (role, isScoped, expectDisabled) => {
      Object.assign(scopeMocks.scopeState, {
        role,
        isScoped,
        canWrite: role !== 'viewer',
        isAdmin: role === 'admin',
      });

      await renderPanel();

      const rebootButton = screen.getByRole('button', { name: /systemPanel\.rebootButton/ });
      expect(rebootButton.hasAttribute('disabled')).toBe(expectDisabled);

      const fanButtons = screen.getAllByRole('button', {
        name: /systemPanel\.fan(Off|Low|Medium|High|Max)/,
      });
      expect(fanButtons).toHaveLength(5);
      for (const button of fanButtons) {
        expect(button.hasAttribute('disabled')).toBe(expectDisabled);
      }

      if (expectDisabled) {
        expect(rebootButton).toHaveAttribute('title', 'adminOnly');
        for (const button of fanButtons) {
          expect(button).toHaveAttribute('title', 'adminOnly');
        }
      } else {
        expect(rebootButton).not.toHaveAttribute('title');
        for (const button of fanButtons) {
          expect(button).not.toHaveAttribute('title');
        }
      }
    },
  );

  it('never calls setFan for a scoped non-admin even on a forced click', async () => {
    Object.assign(scopeMocks.scopeState, { role: 'researcher', isScoped: true, canWrite: true, isAdmin: false });
    await renderPanel();

    const fanButtons = screen.getAllByRole('button', {
      name: /systemPanel\.fan(Off|Low|Medium|High|Max)/,
    });
    fanButtons[0].removeAttribute('disabled');
    fireEvent.click(fanButtons[0]);

    expect(apiMocks.setFan).not.toHaveBeenCalled();
  });

  it('leaves reboot/fan enabled for a viewer in non-scoped installs (unchanged behavior)', async () => {
    Object.assign(scopeMocks.scopeState, { role: 'viewer', isScoped: false, canWrite: false, isAdmin: false });
    await renderPanel();

    expect(screen.getByRole('button', { name: /systemPanel\.rebootButton/ }).hasAttribute('disabled')).toBe(false);
  });

  // F51: ScopeContext derives `isScoped` from `profile?.features`, and
  // `profile` starts null -- so `isScoped` reads `false` for the entire
  // window before the scope profile resolves, on BOTH scoped and non-scoped
  // installs. Gating only on `isScoped` (without `resolved`) therefore
  // failed OPEN on a scoped install for that whole window. These two cases
  // are the regression: the admin field itself (`isAdmin`) is irrelevant
  // here on purpose -- disabled must hold regardless of what it happens to
  // be, because the profile hasn't loaded and the caller cannot know yet.
  it.each([
    ['scoped install, still resolving', true],
    ['non-scoped install, still resolving', false],
  ] as const)('fails closed while loading (%s)', async (_label, isScoped) => {
    Object.assign(scopeMocks.scopeState, {
      role: 'admin',
      isScoped,
      canWrite: true,
      isAdmin: true,
      loading: true,
      resolved: false,
    });
    await renderPanel();

    expect(screen.getByRole('button', { name: /systemPanel\.rebootButton/ }).hasAttribute('disabled')).toBe(true);
    const fanButtons = screen.getAllByRole('button', {
      name: /systemPanel\.fan(Off|Low|Medium|High|Max)/,
    });
    for (const button of fanButtons) {
      expect(button.hasAttribute('disabled')).toBe(true);
    }
  });

  it('exposes admin-only gating to assistive tech via aria-disabled and a visible, describedby-linked hint', async () => {
    Object.assign(scopeMocks.scopeState, { role: 'researcher', isScoped: true, canWrite: true, isAdmin: false });
    await renderPanel();

    const rebootButton = screen.getByRole('button', { name: /systemPanel\.rebootButton/ });
    expect(rebootButton).toHaveAttribute('aria-disabled', 'true');
    const rebootHintId = rebootButton.getAttribute('aria-describedby');
    expect(rebootHintId).toBeTruthy();
    expect(document.getElementById(rebootHintId as string)?.textContent).toBe('adminOnly');

    const fanButtons = screen.getAllByRole('button', {
      name: /systemPanel\.fan(Off|Low|Medium|High|Max)/,
    });
    for (const button of fanButtons) {
      expect(button).toHaveAttribute('aria-disabled', 'true');
      const fanHintId = button.getAttribute('aria-describedby');
      expect(fanHintId).toBeTruthy();
      expect(document.getElementById(fanHintId as string)?.textContent).toBe('adminOnly');
    }
  });
});
