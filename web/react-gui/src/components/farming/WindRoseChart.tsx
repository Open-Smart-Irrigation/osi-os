import React from 'react';
import { EChart } from '../analysis/EChart';
import type { WindRose } from '../../utils/wind';

export interface WindRoseTheme {
  axisLine: string;
  axisLabel: string;
  splitLine: string;
  legendText: string;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function readTheme(): WindRoseTheme {
  return {
    axisLine: cssVar('--border', '#e2e8f0'),
    axisLabel: cssVar('--text-secondary', '#64748b'),
    splitLine: cssVar('--border', '#e2e8f0'),
    legendText: cssVar('--text-secondary', '#64748b'),
  };
}

// Orientation: N at top (startAngle 90), sectors clockwise NNE -> E -> S -> W.
export function buildWindRoseOption(rose: WindRose, theme: WindRoseTheme): Record<string, unknown> {
  const directions = rose.sectors.map((sector) => sector.direction);

  return {
    tooltip: { trigger: 'item' },
    legend: {
      data: rose.speedBins.map((bin) => bin.label),
      bottom: 0,
      textStyle: { color: theme.legendText },
    },
    polar: {},
    angleAxis: {
      type: 'category',
      data: directions,
      startAngle: 90,
      clockwise: true,
      boundaryGap: true,
      axisLine: { lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.axisLabel },
    },
    radiusAxis: {
      min: 0,
      axisLabel: {
        color: theme.axisLabel,
        formatter: (value: number) => `${Math.round(value)}%`,
      },
      splitLine: { lineStyle: { color: theme.splitLine } },
    },
    series: rose.speedBins.map((bin, binIndex) => ({
      name: bin.label,
      type: 'bar',
      coordinateSystem: 'polar',
      stack: 'total',
      data: rose.sectors.map((sector) => sector.bins[binIndex]),
      itemStyle: { color: bin.color },
    })),
  };
}

export const WindRoseChart: React.FC<{ rose: WindRose }> = ({ rose }) => {
  const option = React.useMemo(() => buildWindRoseOption(rose, readTheme()), [rose]);

  return (
    <div style={{ width: '100%', height: 340 }}>
      <EChart option={option} className="h-full w-full" />
    </div>
  );
};
