import { useEffect, type RefObject } from 'react';

export function useDismissOnPointerDown<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    const handler = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onDismiss();
      }
    };

    document.addEventListener('pointerdown', handler);
    return () => {
      document.removeEventListener('pointerdown', handler);
    };
  }, [onDismiss, ref]);
}
