import React, { useMemo, useState } from 'react';
import {
  applyDayClick,
  applyDayDoubleClick,
  isInRange,
  monthGridDays,
  shiftMonth,
  type RangeValue,
} from './rangeCalendarModel';

interface RangeCalendarProps {
  value: RangeValue;
  onChange: (value: RangeValue) => void;
  todayIso: string;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function initialMonth(value: RangeValue, todayIso: string): { year: number; month: number } {
  const date = value.from || todayIso;
  const [year, month] = date.split('-').map(Number);
  return {
    year: Number.isFinite(year) ? year : new Date().getUTCFullYear(),
    month: Number.isFinite(month) ? month : new Date().getUTCMonth() + 1,
  };
}

export const RangeCalendar: React.FC<RangeCalendarProps> = ({ value, onChange, todayIso }) => {
  const [visible, setVisible] = useState(() => initialMonth(value, todayIso));
  const days = useMemo(
    () => monthGridDays(visible.year, visible.month, todayIso),
    [todayIso, visible.month, visible.year],
  );
  const monthLabel = new Date(Date.UTC(visible.year, visible.month - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  const moveMonth = (delta: number) => {
    setVisible((current) => shiftMonth(current.year, current.month, delta));
  };

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3" data-testid="range-calendar">
      <div className="mb-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => moveMonth(-1)}
          className="h-9 w-9 rounded-lg border border-[var(--border)] text-lg text-[var(--text)]"
          aria-label="Previous month"
        >
          ‹
        </button>
        <p className="text-sm font-semibold text-[var(--text)]">{monthLabel}</p>
        <button
          type="button"
          onClick={() => moveMonth(1)}
          className="h-9 w-9 rounded-lg border border-[var(--border)] text-lg text-[var(--text)]"
          aria-label="Next month"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((day) => (
          <span key={day} className="pb-1 text-[10px] font-semibold uppercase text-[var(--text-tertiary)]">
            {day}
          </span>
        ))}
        {days.map((day) => {
          const endpoint = day.date === value.from || day.date === value.to;
          const inRange = isInRange(day.date, value.from, value.to);
          const disabled = day.isFuture || !day.inMonth;
          return (
            <button
              key={day.date}
              type="button"
              data-testid={`day-${day.date}`}
              disabled={disabled}
              aria-pressed={endpoint}
              onClick={() => onChange(applyDayClick(value, day.date))}
              onDoubleClick={() => onChange(applyDayDoubleClick(value, day.date))}
              className={[
                'aspect-square rounded-md text-xs font-medium transition-colors',
                endpoint ? 'bg-[var(--primary)] text-white' : '',
                !endpoint && inRange ? 'bg-[var(--secondary-bg)] text-[var(--text)]' : '',
                !endpoint && !inRange ? 'text-[var(--text)]' : '',
                disabled ? 'cursor-not-allowed opacity-30' : 'hover:bg-[var(--secondary-bg)]',
              ].join(' ')}
            >
              {day.day}
            </button>
          );
        })}
      </div>
    </div>
  );
};
