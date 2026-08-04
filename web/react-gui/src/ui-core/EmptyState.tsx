import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}

export function EmptyState({ title, subtitle, children }: EmptyStateProps) {
  return (
    <div className="text-center py-12 bg-[var(--surface)] rounded-xl border-2 border-[var(--border)]">
      <p className="text-[var(--text)] text-2xl font-bold mb-4">{title}</p>
      {subtitle && <p className="text-[var(--text-tertiary)] text-lg mb-6">{subtitle}</p>}
      {children && <div className="flex gap-4 justify-center">{children}</div>}
    </div>
  );
}
