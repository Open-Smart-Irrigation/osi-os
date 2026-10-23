// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { AnalysisChartLegend } from '../AnalysisChartLegend';

const series = [
  { seriesId: 'a', label: 'Chameleon 1: SWT 5cm' },
  { seriesId: 'b', label: 'Dendro1: External temperature' },
];

afterEach(cleanup);

describe('AnalysisChartLegend', () => {
  it('renders one row per series with its label', () => {
    render(<AnalysisChartLegend series={series} onRename={vi.fn()} />);
    expect(screen.getByText('Chameleon 1: SWT 5cm')).toBeInTheDocument();
    expect(screen.getByText('Dendro1: External temperature')).toBeInTheDocument();
  });

  it('opens an input on single click and commits on Enter', () => {
    const onRename = vi.fn();
    render(<AnalysisChartLegend series={series} onRename={onRename} />);
    fireEvent.click(screen.getByText('Chameleon 1: SWT 5cm'));
    const input = screen.getByDisplayValue('Chameleon 1: SWT 5cm');
    fireEvent.change(input, { target: { value: 'Soil A' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('a', 'Soil A');
  });

  it('clears the override when committed empty', () => {
    const onRename = vi.fn();
    render(<AnalysisChartLegend series={series} onRename={onRename} />);
    fireEvent.click(screen.getByText('Dendro1: External temperature'));
    const input = screen.getByDisplayValue('Dendro1: External temperature');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('b', null);
  });

  it('cancels on Escape without calling onRename', () => {
    const onRename = vi.fn();
    render(<AnalysisChartLegend series={series} onRename={onRename} />);
    fireEvent.click(screen.getByText('Chameleon 1: SWT 5cm'));
    fireEvent.keyDown(screen.getByDisplayValue('Chameleon 1: SWT 5cm'), { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('truncates a long label inside the legend and keeps the full name in the title', () => {
    const long = 'Chameleon soil probe north-east corner: soil water tension at 30 cm';
    render(<AnalysisChartLegend series={[{ seriesId: 'a', label: long }]} onRename={vi.fn()} />);
    const text = screen.getByText(long);
    expect(text).toHaveClass('truncate');
    const button = text.closest('button');
    expect(button).toHaveClass('min-w-0', 'max-w-full');
    expect(button?.getAttribute('title')).toContain(long);
    expect(text.closest('li')).toHaveClass('min-w-0', 'max-w-full');
  });
});
