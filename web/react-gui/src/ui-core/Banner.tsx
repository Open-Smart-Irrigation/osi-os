import type { ReactNode } from 'react';

export type BannerTone = 'warn' | 'error' | 'success' | 'info';

const TONE_CLASSES: Record<BannerTone, string> = {
  warn: 'border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn-text)]',
  error: 'border-[var(--danger-fg)] bg-[var(--error-bg)] text-[var(--error-text)]',
  success: 'border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success-text)]',
  info: 'border-[var(--info-border)] bg-[var(--info-bg)] text-[var(--info-text)]',
};

export interface BannerProps {
  tone?: BannerTone;
  className?: string;
  children: ReactNode;
}

export function Banner({ tone = 'warn', className = '', children }: BannerProps) {
  const role = tone === 'error' ? 'alert' : 'status';
  return (
    <div
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      className={`border-b px-4 py-3 text-center text-sm font-semibold ${TONE_CLASSES[tone]} ${className}`.trim()}
    >
      {children}
    </div>
  );
}
