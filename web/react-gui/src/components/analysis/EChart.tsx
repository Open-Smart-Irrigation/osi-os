import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

use([LineChart, ScatterChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

function withLegendSelection(option: Record<string, unknown>, selected: Record<string, boolean> | null): Record<string, unknown> {
  const legend = option.legend;
  if (!selected || !legend || typeof legend !== 'object' || Array.isArray(legend)) return option;
  return { ...option, legend: { ...(legend as Record<string, unknown>), selected: { ...selected } } };
}

interface EChartProps {
  option: Record<string, unknown>;
  exportOption?: Record<string, unknown>;
  className?: string;
  onAxisNameClick?: (channelKey: string, pos: { x: number; y: number }) => void;
}

export interface EChartHandle {
  getDataURL: () => string | null;
  getExportDataURL: () => string | null;
}

export const EChart = forwardRef<EChartHandle, EChartProps>(function EChart({ option, exportOption, className, onAxisNameClick }, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const optionRef = useRef(option);
  optionRef.current = option;
  const exportOptionRef = useRef(exportOption);
  exportOptionRef.current = exportOption;
  const onAxisNameClickRef = useRef(onAxisNameClick);
  onAxisNameClickRef.current = onAxisNameClick;
  // Legend toggles live in the chart instance; `setOption(..., true)` would
  // reset them on every new option (resizes rebuild the option). Keep them.
  const legendSelectedRef = useRef<Record<string, boolean> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = init(containerRef.current);
    chartRef.current = chart;

    chart.on('click', (params: any) => {
      if (params.componentType !== 'yAxis' || params.targetType !== 'axisName') return;
      const yAxis = (chart.getOption() as any).yAxis?.[params.componentIndex ?? 0];
      const id: string | undefined = yAxis?.id;
      if (!id) return;
      const channelKey = id.split('#')[0];
      onAxisNameClickRef.current?.(channelKey, { x: params.event?.offsetX ?? 0, y: params.event?.offsetY ?? 0 });
    });

    chart.on('legendselectchanged', (params: any) => {
      if (params?.selected && typeof params.selected === 'object') legendSelectedRef.current = { ...params.selected };
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(withLegendSelection(option, legendSelectedRef.current), true);
  }, [option]);

  useImperativeHandle(ref, () => {
    const snapshot = () =>
      chartRef.current?.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' }) ?? null;

    return {
      getDataURL: snapshot,
      getExportDataURL: () => {
        const container = containerRef.current;
        if (!exportOptionRef.current || !container) return snapshot();
        // Render the export option in a detached, correctly-sized instance so the
        // live chart is never mutated (mutating it mid-render corrupted the export).
        const rect = container.getBoundingClientRect();
        const div = document.createElement('div');
        div.style.cssText = `position:absolute;left:-99999px;top:0;width:${Math.max(1, Math.round(rect.width))}px;height:${Math.max(320, Math.round(rect.height))}px;`;
        document.body.appendChild(div);
        const offscreen = init(div);
        try {
          offscreen.setOption({ ...(exportOptionRef.current as Record<string, unknown>), animation: false });
          return offscreen.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
        } finally {
          offscreen.dispose();
          div.remove();
        }
      },
    };
  }, []);

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%', minHeight: 320 }} />;
});
