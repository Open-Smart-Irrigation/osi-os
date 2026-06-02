import React from 'react';
import { useTranslation } from 'react-i18next';
import { soilStatusVisual } from '../../../history/soilStatus';
import type { HistoryProfilePoint } from '../../../history/types';

interface SoilProfileViewProps {
  profiles: HistoryProfilePoint[];
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

interface RenderableProfilePoint {
  renderKey: string;
  label: string | null;
  depthCm: number | null;
  value: number | null;
  unit: string | null;
  status: string | null;
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isGenericSoilLayerLabel(label: string | null): boolean {
  return label !== null && /^soil\s+\d+$/i.test(label);
}

function normalizeProfilePoint(
  t: HistoryTranslate,
  point: Partial<HistoryProfilePoint> | null | undefined,
  index: number,
): RenderableProfilePoint {
  const id = normalizeText(point?.id);
  const label = normalizeText(point?.label);
  return {
    renderKey: id ?? `profile-${index}`,
    label,
    depthCm: normalizeFiniteNumber(point?.depthCm),
    value: normalizeFiniteNumber(point?.value),
    unit: normalizeText(point?.unit),
    status: normalizeText(point?.status),
  };
}

function compareProfileDepth(a: RenderableProfilePoint, b: RenderableProfilePoint): number {
  const aDepth = a.depthCm ?? Number.POSITIVE_INFINITY;
  const bDepth = b.depthCm ?? Number.POSITIVE_INFINITY;
  if (aDepth !== bDepth) return aDepth - bDepth;
  return (a.label ?? '').localeCompare(b.label ?? '');
}

function formatValue(t: HistoryTranslate, point: RenderableProfilePoint): string {
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
  const visual = soilStatusVisual(status);
  if (visual) return t(visual.labelKey);
  return t(`history.soilProfile.status.${status}`, { defaultValue: humanizeStatus(status) });
}

export const SoilProfileView: React.FC<SoilProfileViewProps> = ({ profiles }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const sortedProfiles = profiles
    .map((point, index) => normalizeProfilePoint(t, point, index))
    .sort(compareProfileDepth);

  if (sortedProfiles.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
      <div className="grid gap-3 my-auto">
        {sortedProfiles.map((point, index) => {
          const visual = soilStatusVisual(point.status);
          const label = point.label && !isGenericSoilLayerLabel(point.label)
            ? point.label
            : t('history.soilProfile.labelUnknown', { index: index + 1 });
          const style = visual
            ? {
                '--soil-row-color': visual.colorVar,
                borderColor: visual.colorVar,
                background: `color-mix(in srgb, ${visual.colorVar} 12%, var(--surface))`,
              } as React.CSSProperties
            : undefined;
          return (
            <div
              key={point.renderKey}
              data-testid={`soil-profile-row-${index}`}
              style={style}
              className="grid min-h-[4.25rem] grid-cols-[minmax(4rem,6rem)_1fr] gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 sm:grid-cols-[minmax(5rem,7rem)_1fr_auto]"
            >
              <div className="flex items-center justify-center rounded-md bg-[var(--secondary-bg)] px-2 text-center text-sm font-semibold text-[var(--text)]">
                {formatDepth(t, point.depthCm)}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[var(--text)]">{label}</p>
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
          );
        })}
      </div>
    </div>
  );
};
