import type { ReactNode } from 'react';

export interface ModalProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode;
}

export function Modal({ isOpen, title, onClose, closeLabel = 'Close', children }: ModalProps) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-[color-mix(in_srgb,var(--overlay)_70%,transparent)] flex items-center justify-center z-50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-[var(--card)] rounded-2xl shadow-2xl border-2 border-[var(--border)] max-w-lg w-full max-h-[calc(100dvh-2rem)] overflow-y-auto p-8"
      >
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold text-[var(--text)] high-contrast-text">{title}</h2>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text)] text-3xl leading-none"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
