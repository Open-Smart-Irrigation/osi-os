import React from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryProfilePoint } from '../../../history/types';

interface SoilProfileViewProps {
  profiles: HistoryProfilePoint[];
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function compareProfileDepth(a: HistoryProfilePoint, b: HistoryProfilePoint): number {
  const aDepth = a.depthCm ?? Number.POSITIVE_INFINITY;
  const bDepth = b.depthCm ?? Number.POSITIVE_INFINITY;
  if (aDepth !== bDepth) return aDepth - bDepth;
  return a.label.localeCompare(b.label);
}

function formatValue(t: HistoryTranslate, point: HistoryProfilePoint): string {
  if (point.value === null) return t('history.soilProfile.valueMissing');
  return point.unit ? `${point.value} ${point.unit}` : String(point.value);
}

function formatDepth(t: HistoryTranslate, depthCm: number | null | undefined): string {
  if (depthCm === null || depthCm === undefined) return t('history.soilProfile.depthUnknown');
  return t('history.soilProfile.depthLabel', { depth: depthCm });
}

function humanizeStatus(status: string): string {
  return status
    .split('_')
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function formatStatus(t: HistoryTranslate, status: string): string {
  return t(`history.soilProfile.status.${status}`, { defaultValue: humanizeStatus(status) });
}

export const SoilProfileView: React.FC<SoilProfileViewProps> = ({ profiles }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const sortedProfiles = [...profiles].sort(compareProfileDepth);

  if (sortedProfiles.length === 0) {
    return (
      <div className="mt-4 flex min-h-[240px] items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6 text-center">
        <div>
          <p className="text-sm font-semibold text-[var(--text)]">
            {t('history.soilProfile.emptyTitle')}
          </p>
          <p className="mt-2 text-sm text-[var(--text-tertiary)]">
            {t('history.soilProfile.emptyBody')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 min-h-[240px] rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4">
      <div className="grid gap-3">
        {sortedProfiles.map((point) => (
          <div
            key={point.id}
            className="grid min-h-[4.25rem] grid-cols-[minmax(4rem,6rem)_1fr] gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 sm:grid-cols-[minmax(5rem,7rem)_1fr_auto]"
          >
            <div className="flex items-center justify-center rounded-md bg-[var(--secondary-bg)] px-2 text-center text-sm font-semibold text-[var(--text)]">
              {formatDepth(t, point.depthCm)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[var(--text)]">{point.label}</p>
              {point.status && (
                <p className="mt-1 break-words text-xs font-medium text-[var(--text-tertiary)]">
                  {formatStatus(t, point.status)}
                </p>
              )}
            </div>
            <div className="col-span-2 flex items-center text-base font-bold text-[var(--text)] sm:col-span-1 sm:justify-end">
              {formatValue(t, point)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
