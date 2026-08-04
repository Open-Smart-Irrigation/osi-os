import type { HTMLAttributes } from 'react';

export type SurfaceVariant = 'card' | 'muted' | 'chrome';

const VARIANT_CLASSES: Record<SurfaceVariant, string> = {
  card: 'rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-sm',
  muted: 'rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm',
  chrome: 'glass-chrome',
};

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SurfaceVariant;
}

export function Surface({ variant = 'card', className = '', ...rest }: SurfaceProps) {
  return <div className={`${VARIANT_CLASSES[variant]} ${className}`.trim()} {...rest} />;
}
