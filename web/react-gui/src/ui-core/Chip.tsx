import type { HTMLAttributes } from 'react';

export type ChipTone = 'neutral' | 'success' | 'warn' | 'error' | 'info';

const TONE_CLASSES: Record<ChipTone, string> = {
  neutral: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]',
  success: 'border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success-text)]',
  warn: 'border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn-text)]',
  error: 'border-[var(--danger-fg)] bg-[var(--error-bg)] text-[var(--error-text)]',
  info: 'border-[var(--info-border)] bg-[var(--info-bg)] text-[var(--info-text)]',
};

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
}

export function Chip({ tone = 'neutral', className = '', ...rest }: ChipProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${TONE_CLASSES[tone]} ${className}`.trim()}
      {...rest}
    />
  );
}
