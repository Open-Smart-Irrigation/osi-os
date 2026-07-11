import { describe, expect, it } from 'vitest';
import { formatDisplayUnit, historyValueYAxis } from '../visualizations/chartAxis';

describe('formatDisplayUnit', () => {
  it('maps raw unit tokens to display units', () => {
    expect(formatDisplayUnit('C')).toBe('°C');
    expect(formatDisplayUnit('um')).toBe('µm');
  });
  it('passes through unknown units and blanks', () => {
    expect(formatDisplayUnit('kPa')).toBe('kPa');
    expect(formatDisplayUnit('')).toBe('');
    expect(formatDisplayUnit(null)).toBe('');
  });
});

describe('historyValueYAxis', () => {
  it('renders the axis title with the display unit', () => {
    expect(historyValueYAxis('um').label).toMatchObject({ value: 'µm' });
  });
});
