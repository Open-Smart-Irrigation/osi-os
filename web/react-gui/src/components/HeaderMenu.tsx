import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

export interface HeaderMenuItem {
  key: string;
  label: React.ReactNode;
  to?: string;
  onSelect?: () => void;
}

interface HeaderMenuProps {
  label: React.ReactNode;
  triggerClassName: string;
  items: HeaderMenuItem[];
  className?: string;
  align?: 'left' | 'right';
}

const ITEM_CLASS =
  'block w-full text-left px-4 py-2 text-sm text-[var(--text)] hover:bg-[var(--card)] focus:bg-[var(--card)] outline-none transition-colors';

export const HeaderMenu: React.FC<HeaderMenuProps> = ({
  label,
  triggerClassName,
  items,
  className,
  align = 'right',
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  const close = (focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  };

  const moveFocus = (delta: number) => {
    const focusable = itemRefs.current.filter(Boolean) as HTMLElement[];
    if (focusable.length === 0) return;

    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = (activeIndex + delta + focusable.length) % focusable.length;
    focusable[nextIndex].focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
    }
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onContainerBlur = (event: React.FocusEvent) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (containerRef.current && nextTarget && containerRef.current.contains(nextTarget)) return;
    setOpen(false);
  };

  return (
    <div ref={containerRef} onBlur={onContainerBlur} className={`relative ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex w-full items-center justify-center gap-1.5 rounded-lg font-bold transition-colors ${triggerClassName}`}
      >
        {label}
        <span aria-hidden="true" className="text-xs opacity-70">{open ? '^' : 'v'}</span>
      </button>

      {open && (
        <div
          role="menu"
          onKeyDown={onMenuKeyDown}
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full z-50 mt-1 min-w-[180px] rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-xl`}
        >
          {items.map((item, index) =>
            item.to ? (
              <Link
                key={item.key}
                to={item.to}
                role="menuitem"
                tabIndex={-1}
                ref={(element) => { itemRefs.current[index] = element; }}
                className={ITEM_CLASS}
                onClick={() => close(false)}
              >
                {item.label}
              </Link>
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                ref={(element) => { itemRefs.current[index] = element; }}
                className={ITEM_CLASS}
                onClick={() => {
                  item.onSelect?.();
                  close(false);
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
};
