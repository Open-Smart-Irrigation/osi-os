import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HistoryMonthCalendarView } from '../visualizations/HistoryMonthCalendarView';
import { formatHistoryCalendarMonthLabel } from '../../../history/calendarMonth';
import type { HistoryCalendar } from '../../../history/types';

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.calendar.title': 'Calendar',
    'history.calendar.emptyTitle': 'No calendar data',
    'history.calendar.weekday.mon': 'Mon',
    'history.calendar.weekday.tue': 'Tue',
    'history.calendar.weekday.wed': 'Wed',
    'history.calendar.weekday.thu': 'Thu',
    'history.calendar.weekday.fri': 'Fri',
    'history.calendar.weekday.sat': 'Sat',
    'history.calendar.weekday.sun': 'Sun',
    'history.calendar.state.dry_stress': 'Dry stress',
    'history.calendar.state.optimal': 'Optimal',
    'history.calendar.state.no_data': 'No data',
    'history.calendar.state.normal_growth': 'Normal growth',
    'history.calendar.summary.soil.dry_stress': '{{sampleCount}} samples showed dry stress',
    'history.calendar.summary.soil.optimal': '{{sampleCount}} samples looked optimal',
    'history.calendar.summary.soil.no_data': 'No soil data',
    'history.calendar.summary.dendro.normal_growth': 'Normal growth day',
    'history.calendar.marker.soil.dry_stress': 'Dry stress marker',
    'history.calendar.marker.rain': 'Rain',
    'history.metadata.coverageKnown': '{{coverage}}% coverage',
    'history.metadata.coverageUnknown': 'Coverage unknown',
  };

  return {
    translateForTest: (key: string, options?: Record<string, unknown>): string => {
      const template = translations[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translateForTest }),
}));

function soilCalendarMay2026(): HistoryCalendar {
  return {
    timezone: 'UTC',
    days: [
      {
        date: '2026-05-01',
        state: 'dry_stress',
        coveragePct: 91,
        coverageConfidence: 'configured',
        summary: { key: 'history.calendar.summary.soil.dry_stress', params: { sampleCount: 8 } },
        markers: [
          { type: 'state', severity: 'warning', labelKey: 'history.calendar.marker.soil.dry_stress' },
          { type: 'rain', severity: 'info', labelKey: 'history.calendar.marker.rain' },
        ],
      },
      {
        date: '2026-05-12',
        state: 'optimal',
        coveragePct: 100,
        coverageConfidence: 'configured',
        summary: { key: 'history.calendar.summary.soil.optimal', params: { sampleCount: 10 } },
        markers: [],
      },
      {
        date: '2026-05-31',
        state: 'no_data',
        coveragePct: null,
        coverageConfidence: 'unknown',
        summary: { key: 'history.calendar.summary.soil.no_data' },
        markers: [],
      },
    ],
  };
}

function dendroCalendarMay2026(): HistoryCalendar {
  return {
    timezone: 'UTC',
    days: [
      {
        date: '2026-05-12',
        state: 'normal_growth',
        coveragePct: 87,
        coverageConfidence: 'derived',
        summary: { key: 'history.calendar.summary.dendro.normal_growth' },
        markers: [],
      },
    ],
  };
}

function dendroCalendarJuly2026(): HistoryCalendar {
  return {
    timezone: 'UTC',
    days: [
      {
        date: '2026-07-05',
        state: 'normal_growth',
        coveragePct: 100,
        coverageConfidence: 'configured',
        summary: { key: 'history.calendar.summary.dendro.normal_growth' },
        markers: [],
      },
      {
        date: '2026-07-20',
        state: 'no_data',
        coveragePct: null,
        coverageConfidence: 'unknown',
        markers: [],
      },
    ],
  };
}

describe('HistoryMonthCalendarView', () => {
  it('formats the active month from calendar data for shared detail context', () => {
    const calendarWithJuneDays: HistoryCalendar = {
      timezone: 'UTC',
      days: [
        {
          date: '2026-06-05',
          state: 'optimal',
          coveragePct: 100,
          coverageConfidence: 'configured',
          markers: [],
        },
      ],
    };
    const calendarSpanningMayAndJune: HistoryCalendar = {
      timezone: 'UTC',
      days: [
        {
          date: '2026-05-31',
          state: 'optimal',
          coveragePct: 100,
          coverageConfidence: 'configured',
          markers: [],
        },
        {
          date: '2026-06-01',
          state: 'dry_stress',
          coveragePct: 91,
          coverageConfidence: 'configured',
          markers: [],
        },
      ],
    };
    const calendarWithPacificKiritimatiTimezone: HistoryCalendar = {
      ...calendarWithJuneDays,
      timezone: 'Pacific/Kiritimati',
    };

    expect(formatHistoryCalendarMonthLabel(calendarWithJuneDays)).toMatch(/June 2026/);
    expect(formatHistoryCalendarMonthLabel(calendarSpanningMayAndJune)).toMatch(/June 2026/);
    expect(formatHistoryCalendarMonthLabel(null)).toBeNull();
    expect(formatHistoryCalendarMonthLabel(calendarWithPacificKiritimatiTimezone)).toMatch(/June 2026/);
  });

  it('renders a recognizable month grid with weekday headers', () => {
    render(<HistoryMonthCalendarView cardType="soil" calendar={soilCalendarMay2026()} onInspectDate={vi.fn()} />);

    expect(screen.getByRole('grid', { name: /May 2026/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Mon' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Sun' })).toBeInTheDocument();
    expect(screen.getByRole('gridcell', { name: /May 31/i })).toBeInTheDocument();
  });

  it('colors days by theme-specific state and keeps no-data visually distinct', () => {
    render(<HistoryMonthCalendarView cardType="soil" calendar={soilCalendarMay2026()} onInspectDate={vi.fn()} />);

    expect(screen.getByTestId('calendar-cell-2026-05-01')).toHaveAttribute('data-state', 'dry_stress');
    expect(screen.getByTestId('calendar-cell-2026-05-01')).toHaveStyle('--calendar-cell-bg: var(--soil-dry-bg)');
    expect(screen.getByTestId('calendar-cell-2026-05-12')).toHaveAttribute('data-state', 'optimal');
    expect(screen.getByTestId('calendar-cell-2026-05-12')).toHaveStyle('--calendar-cell-bg: var(--soil-moist-bg)');
    expect(screen.getByRole('gridcell', { name: /May 31.*No data/i })).toHaveAttribute('data-state', 'no_data');
  });

  it('selects a day for the inspector when tapped', () => {
    const onInspectDate = vi.fn();
    render(<HistoryMonthCalendarView cardType="dendro" calendar={dendroCalendarMay2026()} onInspectDate={onInspectDate} />);

    fireEvent.click(screen.getByRole('gridcell', { name: /May 12/i }));

    expect(onInspectDate).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-05-12',
      day: expect.objectContaining({ state: 'normal_growth', coveragePct: 87 }),
    }));
  });

  it('keeps calendar touch events from bubbling into a parent gesture surface', () => {
    const onInspectDate = vi.fn();
    const onParentPointerDown = vi.fn();

    render(
      <div onPointerDown={onParentPointerDown}>
        <HistoryMonthCalendarView cardType="soil" calendar={soilCalendarMay2026()} onInspectDate={onInspectDate} />
      </div>,
    );

    const cell = screen.getByRole('gridcell', { name: /May 12/i });
    fireEvent.pointerDown(cell, { pointerId: 1, pointerType: 'touch', clientX: 120, clientY: 120 });
    fireEvent.pointerUp(cell, { pointerId: 1, pointerType: 'touch', clientX: 120, clientY: 120 });

    expect(onInspectDate).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-05-12' }));
    expect(onParentPointerDown).not.toHaveBeenCalled();
  });

  it('does not open the inspector when a touch gesture starts on a day cell and moves away', () => {
    const onInspectDate = vi.fn();
    render(
      <HistoryMonthCalendarView cardType="dendro" calendar={dendroCalendarMay2026()} onInspectDate={onInspectDate} />,
    );
    const cell = screen.getByTestId('calendar-cell-2026-05-12');
    fireEvent.pointerDown(cell, { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(cell, { pointerType: 'touch', pointerId: 1, clientX: 160, clientY: 100 });
    fireEvent.pointerUp(cell, { pointerType: 'touch', pointerId: 1, clientX: 160, clientY: 100 });
    expect(onInspectDate).not.toHaveBeenCalled();
  });

  it('opens the inspector on a touch tap (down and up without movement)', () => {
    const onInspectDate = vi.fn();
    render(
      <HistoryMonthCalendarView cardType="dendro" calendar={dendroCalendarMay2026()} onInspectDate={onInspectDate} />,
    );
    const cell = screen.getByTestId('calendar-cell-2026-05-12');
    fireEvent.pointerDown(cell, { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(cell, { pointerType: 'touch', pointerId: 1, clientX: 103, clientY: 101 });
    expect(onInspectDate).toHaveBeenCalledTimes(1);
  });

  it('renders the latest month when a rolling range spans month boundaries', () => {
    render(
      <HistoryMonthCalendarView
        cardType="soil"
        calendar={{
          timezone: 'UTC',
          days: [
            {
              date: '2026-05-31',
              state: 'optimal',
              coveragePct: 100,
              coverageConfidence: 'configured',
              markers: [],
            },
            {
              date: '2026-06-01',
              state: 'dry_stress',
              coveragePct: 91,
              coverageConfidence: 'configured',
              markers: [],
            },
          ],
        }}
        onInspectDate={vi.fn()}
      />,
    );

    expect(screen.getByRole('grid', { name: /June 2026/i })).toBeInTheDocument();
    expect(document.querySelector('[data-history-calendar-date="2026-06-01"]')).toHaveAttribute(
      'data-state',
      'dry_stress',
    );
    expect(screen.queryByRole('gridcell', { name: /May 31/i })).not.toBeInTheDocument();
  });

  it('renders future days as inert placeholders without a no-data label', () => {
    const onInspectDate = vi.fn();
    render(
      <HistoryMonthCalendarView
        cardType="dendro"
        calendar={dendroCalendarJuly2026()}
        onInspectDate={onInspectDate}
        todayIso="2026-07-11"
      />,
    );
    const futureCell = screen.getByTestId('calendar-cell-2026-07-20');
    expect(futureCell.tagName).toBe('DIV');
    expect(futureCell).toHaveAttribute('data-state', 'future');
    expect(futureCell).not.toHaveTextContent('No data');
    fireEvent.click(futureCell);
    expect(onInspectDate).not.toHaveBeenCalled();
  });
});
