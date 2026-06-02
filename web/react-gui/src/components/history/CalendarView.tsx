import React from 'react';
import { HistoryMonthCalendarView, type HistoryCalendarDateSelection } from './visualizations/HistoryMonthCalendarView';
import type { HistoryCalendar, HistoryCardType } from '../../history/types';

interface CalendarViewProps {
  cardType: HistoryCardType;
  calendar: HistoryCalendar | null | undefined;
  onInspectDate?: (selection: HistoryCalendarDateSelection) => void;
}

export const CalendarView: React.FC<CalendarViewProps> = ({
  cardType,
  calendar,
  onInspectDate,
}) => (
  <HistoryMonthCalendarView
    cardType={cardType}
    calendar={calendar}
    onInspectDate={onInspectDate}
  />
);
