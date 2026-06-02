export interface RangeValue {
  from: string | null;
  to: string | null;
}

export interface GridDay {
  date: string;
  day: number;
  inMonth: boolean;
  isFuture: boolean;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + delta;
  return {
    year: Math.floor(zeroBased / 12),
    month: (zeroBased % 12) + 1,
  };
}

export function monthGridDays(year: number, month: number, todayIso: string): GridDay[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const mondayBasedStart = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: GridDay[] = [];

  const push = (cellYear: number, cellMonth: number, day: number, inMonth: boolean) => {
    const date = isoDate(cellYear, cellMonth, day);
    days.push({ date, day, inMonth, isFuture: date > todayIso });
  };

  const previous = shiftMonth(year, month, -1);
  const previousDays = new Date(Date.UTC(previous.year, previous.month, 0)).getUTCDate();
  for (let offset = mondayBasedStart - 1; offset >= 0; offset -= 1) {
    push(previous.year, previous.month, previousDays - offset, false);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    push(year, month, day, true);
  }

  const next = shiftMonth(year, month, 1);
  let nextDay = 1;
  while (days.length % 7 !== 0) {
    push(next.year, next.month, nextDay, false);
    nextDay += 1;
  }

  return days;
}

export function isInRange(date: string, from: string | null, to: string | null): boolean {
  return Boolean(from && to && date >= from && date <= to);
}

export function applyDayClick(state: RangeValue, date: string): RangeValue {
  if (!state.from || state.to) {
    return { from: date, to: null };
  }
  return date < state.from
    ? { from: date, to: state.from }
    : { from: state.from, to: date };
}

export function applyDayDoubleClick(_state: RangeValue, date: string): RangeValue {
  return { from: date, to: date };
}
