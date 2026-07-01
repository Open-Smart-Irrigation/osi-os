import React from 'react';
import type { HistoryViewport, ViewportBounds } from '../../../history/historyViewport';
import { panViewport } from '../../../history/historyViewport';

interface Props {
  bounds: ViewportBounds;
  viewport: HistoryViewport;
  onChange: (vp: HistoryViewport) => void;
  ariaLabel?: string;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}

export const HistoryOverviewStrip: React.FC<Props> = ({ bounds, viewport, onChange, ariaLabel = 'Time range overview' }) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const total = Math.max(bounds.maxMs - bounds.minMs, 1);
  const rawLeftPct = ((viewport.fromMs - bounds.minMs) / total) * 100;
  const rawRightPct = ((viewport.toMs - bounds.minMs) / total) * 100;
  const leftPct = clampPercent(Math.min(rawLeftPct, rawRightPct));
  const rightPct = clampPercent(Math.max(rawLeftPct, rawRightPct));
  const widthPct = Math.max(rightPct - leftPct, 2);
  const drag = React.useRef<{ startX: number; startVp: HistoryViewport } | null>(null);
  const frame = React.useRef<number | null>(null);
  const pending = React.useRef<HistoryViewport | null>(null);

  const commit = React.useCallback((nextViewport: HistoryViewport) => {
    pending.current = nextViewport;
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!pending.current) return;
      const next = pending.current;
      pending.current = null;
      onChange(next);
    });
  }, [onChange]);

  const onMove = React.useCallback((e: MouseEvent) => {
    const el = ref.current; const d = drag.current;
    if (!el || !d) return;
    const rect = el.getBoundingClientRect();
    const deltaMs = ((e.clientX - d.startX) / rect.width) * total;
    commit(panViewport(d.startVp, bounds, deltaMs));
  }, [bounds, commit, total]);

  React.useEffect(() => {
    const up = () => { drag.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', up);
      if (frame.current != null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      pending.current = null;
    };
  }, [onMove]);

  return (
    <div ref={ref} className="relative mt-2 h-9 rounded-md border border-[var(--border)] bg-[var(--bg)]" role="group" aria-label={ariaLabel}>
      <div
        data-testid="overview-window"
        onMouseDown={(e) => { drag.current = { startX: e.clientX, startVp: viewport }; }}
        className="absolute top-0 bottom-0 cursor-grab bg-[var(--accent,#3b82f6)]/20 border-x-2 border-[var(--accent,#3b82f6)]"
        style={{ left: `${leftPct}%`, width: `${Math.min(widthPct, 100 - leftPct)}%` }}
      />
    </div>
  );
};
