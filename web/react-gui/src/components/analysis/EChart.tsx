import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as echarts from 'echarts';

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
  const chartRef = useRef<echarts.ECharts | null>(null);
  const optionRef = useRef(option);
  optionRef.current = option;
  const exportOptionRef = useRef(exportOption);
  exportOptionRef.current = exportOption;
  const onAxisNameClickRef = useRef(onAxisNameClick);
  onAxisNameClickRef.current = onAxisNameClick;

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current);
    chartRef.current = chart;

    chart.on('click', (params: any) => {
      if (params.componentType !== 'yAxis' || params.targetType !== 'axisName') return;
      const yAxis = (chart.getOption() as any).yAxis?.[params.componentIndex ?? 0];
      const id: string | undefined = yAxis?.id;
      if (!id) return;
      const channelKey = id.split('#')[0];
      onAxisNameClickRef.current?.(channelKey, { x: params.event?.offsetX ?? 0, y: params.event?.offsetY ?? 0 });
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
    chartRef.current?.setOption(option, true);
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
        const offscreen = echarts.init(div);
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
