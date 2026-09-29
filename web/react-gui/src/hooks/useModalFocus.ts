import { useEffect, useRef, type RefObject } from 'react';

interface Entry { element: HTMLElement; opener: HTMLElement | null }
const dialogs: Entry[] = [];
const focusableSelector = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])';
function topDialog() { return dialogs[dialogs.length - 1]; }
function controls(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>(focusableSelector)).filter(control => {
    for (let node: HTMLElement | null = control; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
      if (node === element) break;
    }
    return control.tabIndex >= 0;
  });
}

/** Only the front dialog owns keyboard focus; closing it returns to its opener. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, initialFocus?: string) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = ref.current;
    if (!open || !element) return;
    const entry: Entry = { element, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    // Child effects mount before their parent: insert the parent behind its child.
    const childIndex = dialogs.findIndex(dialog => element.contains(dialog.element));
    dialogs.splice(childIndex < 0 ? dialogs.length : childIndex, 0, entry);
    const focusFirst = () => (controls(element)[0] ?? element).focus();
    if (topDialog() === entry) {
      (initialFocus ? element.querySelector<HTMLElement>(initialFocus) : null)?.focus();
      if (!element.contains(document.activeElement)) focusFirst();
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (topDialog() !== entry) return;
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      } else if (event.key === 'Tab') {
        const items = controls(element);
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length || index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
          event.preventDefault();
          (event.shiftKey ? items[items.length - 1] ?? element : items[0] ?? element).focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (topDialog() === entry && !element.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      const wasTop = topDialog() === entry;
      dialogs.splice(dialogs.indexOf(entry), 1);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocus);
      const successor = topDialog();
      if (wasTop && entry.opener?.isConnected && (!successor || successor.element.contains(entry.opener))) entry.opener.focus();
      else if (wasTop && successor) (controls(successor.element)[0] ?? successor.element).focus();
    };
  }, [ref, open, initialFocus]);
}
