// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../Button';
import { Chip } from '../Chip';
import { Surface } from '../Surface';

afterEach(cleanup);

describe('Surface', () => {
  it('renders the solid card treatment by default', () => {
    render(<Surface data-testid="s">content</Surface>);
    expect(screen.getByTestId('s').className).toContain('bg-[var(--card)]');
    expect(screen.getByTestId('s').className).toContain('rounded-2xl');
  });
  it('renders the glass chrome treatment', () => {
    render(<Surface variant="chrome" data-testid="s" />);
    expect(screen.getByTestId('s').className).toContain('glass-chrome');
  });
});

describe('Button', () => {
  it('defaults to a primary solid button with the touch target', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('touch-target');
    expect(button.className).toContain('bg-[var(--primary)]');
  });
  it('emits the liquid-glass class for the glass variants', () => {
    render(<Button variant="liquid-red">Log in</Button>);
    expect(screen.getByRole('button', { name: 'Log in' }).className).toContain('btn-liquid-red');
  });
});

describe('Chip', () => {
  it('renders tone classes from the status tokens', () => {
    render(<Chip tone="success">OK</Chip>);
    const chip = screen.getByText('OK');
    expect(chip.className).toContain('bg-[var(--success-bg)]');
    expect(chip.className).toContain('rounded-full');
  });
});
