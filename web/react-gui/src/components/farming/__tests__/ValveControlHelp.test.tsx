import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ValveControlHelp } from '../shared/ValveControlHelp';

afterEach(() => cleanup());

describe('ValveControlHelp', () => {
  it('supports pointer, keyboard, and dismissal interactions with a persistent labelled region', async () => {
    const user = userEvent.setup();
    render(<ValveControlHelp label="About Moist">Recommended.</ValveControlHelp>);
    const button = screen.getByRole('button', { name: 'About Moist' });
    const panel = document.getElementById(button.getAttribute('aria-controls')!);
    expect(panel).not.toBeNull();
    expect(button).toHaveAttribute('aria-controls', panel!.id);
    expect(panel).toHaveAttribute('role', 'region');
    expect(panel).toHaveAttribute('aria-label', 'About Moist');
    expect(panel).toHaveAttribute('hidden');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(panel).not.toBeVisible();

    await user.pointer([{ keys: '[MouseLeft>]', target: button }, { keys: '[/MouseLeft]', target: button }]);
    expect(panel).toBeVisible();
    await user.click(button);
    expect(panel).not.toBeVisible();
    await user.click(button);
    expect(panel).toBeVisible();
    await user.click(button);
    expect(panel).not.toBeVisible();

    button.blur();
    await user.hover(document.body);
    await user.hover(button);
    expect(panel).toBeVisible();
    await user.hover(panel!);
    expect(panel).toBeVisible();
    await user.unhover(panel!);
    expect(panel).not.toBeVisible();

    button.focus();
    await user.keyboard('{Enter}');
    expect(panel).toBeVisible();
    await user.keyboard(' ');
    expect(panel).not.toBeVisible();
    await user.keyboard('{Enter}');
    expect(panel).toBeVisible();
    await user.keyboard('{Escape}');
    expect(panel).not.toBeVisible();
    await user.click(button);
    expect(panel).toBeVisible();
    await user.pointer({ keys: '[MouseLeft]', target: document.body });
    expect(panel).not.toBeVisible();
  });

  it('keeps the panel inside both viewport edges', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 });
    render(<ValveControlHelp label="About Moist">Recommended.</ValveControlHelp>);
    const button = screen.getByRole('button', { name: 'About Moist' });
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
    Object.defineProperty(button, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: -40, right: 4, top: 180, bottom: 220, width: 44, height: 40 }),
    });
    Object.defineProperty(panel, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, right: 224, top: 0, bottom: 260, width: 224, height: 260 }),
    });
    fireEvent.click(button);
    const left = Number.parseFloat((panel as HTMLElement).style.left);
    const top = Number.parseFloat((panel as HTMLElement).style.top);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left).toBeLessThanOrEqual(68);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top).toBeLessThanOrEqual(72);
    expect(panel).toHaveStyle({ maxHeight: '184px', overflowY: 'auto' });
  });

  it('repositions a tall open panel after the viewport grows', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 });
    render(<ValveControlHelp label="About Moist">Recommended.</ValveControlHelp>);
    const button = screen.getByRole('button', { name: 'About Moist' });
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
    Object.defineProperty(button, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 200, right: 244, top: 350, bottom: 390, width: 44, height: 40 }),
    });
    Object.defineProperty(panel, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const height = panel.style.maxHeight === 'none' ? 260 : Math.min(260, Number.parseFloat(panel.style.maxHeight) || 260);
        return { left: 0, right: 224, top: 0, bottom: height, width: 224, height };
      },
    });
    fireEvent.click(button);
    expect(panel).toHaveStyle({ maxHeight: '184px', overflowY: 'auto' });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 });
    fireEvent(window, new Event('resize'));
    const top = Number.parseFloat((panel as HTMLElement).style.top);
    expect(panel).toHaveStyle({ maxHeight: '384px', overflowY: 'auto' });
    expect(top).toBeLessThanOrEqual(132);
  });
});
