import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useDismissOnPointerDown } from '../../../hooks/useDismissOnPointerDown';

export interface ValveControlHelpProps { label: string; children: React.ReactNode }

export const ValveControlHelp: React.FC<ValveControlHelpProps> = ({ label, children }) => {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ hover: false, focus: false, pinned: false, suppressed: false });
  const open = !state.suppressed && (state.hover || state.focus || state.pinned);
  const dismiss = useCallback(() => setState({ hover: false, focus: false, pinned: false, suppressed: true }), []);
  useDismissOnPointerDown(ref, dismiss);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dismiss, open]);
  const reposition = useCallback(() => {
    const button = ref.current?.querySelector('button');
    const panel = panelRef.current;
    if (!button || !panel || !open) return;
    const buttonRect = button.getBoundingClientRect();
    panel.style.maxHeight = 'none';
    const panelRect = panel.getBoundingClientRect();
    const margin = 8;
    const maxHeight = Math.max(0, window.innerHeight - margin * 2);
    const width = panelRect.width || Math.min(224, Math.max(0, window.innerWidth - margin * 2));
    const height = Math.min(panelRect.height || 0, maxHeight);
    const left = Math.min(Math.max(buttonRect.right - width, margin), Math.max(margin, window.innerWidth - width - margin));
    const below = buttonRect.bottom;
    const above = buttonRect.top - height;
    const top = below + height + margin <= window.innerHeight
      ? below
      : Math.min(Math.max(above, margin), Math.max(margin, window.innerHeight - height - margin));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${maxHeight}px`;
    panel.style.overflowY = 'auto';
  }, [open]);
  useLayoutEffect(() => {
    reposition();
    if (!open) return undefined;
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
  }, [open, reposition]);
  const activate = () => setState(current => ({ ...current, pinned: !current.pinned, suppressed: current.pinned }));
  return <div ref={ref} className="relative -my-2 -mr-2 shrink-0" onMouseEnter={() => setState(s => ({ ...s, hover: true, suppressed: false }))} onMouseLeave={() => setState(s => ({ ...s, hover: false }))}>
    <button type="button" aria-label={label} aria-expanded={open} aria-controls={id} onFocus={() => setState(s => ({ ...s, focus: true, suppressed: false }))} onBlur={() => setState(s => ({ ...s, focus: false }))} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } }} onClick={activate} className="flex min-h-12 min-w-12 items-center justify-center rounded-full text-base text-[var(--text-secondary)] hover:bg-[var(--card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">ⓘ</button>
    <div ref={panelRef} id={id} role="region" aria-label={label} hidden={!open} onMouseEnter={() => setState(s => ({ ...s, hover: true, suppressed: false }))} onMouseLeave={() => setState(s => ({ ...s, hover: false }))} className="fixed z-20 w-56 max-w-[calc(100vw-1rem)] whitespace-normal break-words rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 text-xs text-[var(--text)] shadow-lg">{children}</div>
  </div>;
};
