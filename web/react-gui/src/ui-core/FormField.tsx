import type { ReactNode } from 'react';

/** Verbatim input treatment from the edge modals (CreateZoneModal / AddDeviceModal). */
export const INPUT_CLASS =
  'w-full px-4 py-4 touch-target bg-[var(--card)] border-2 border-[var(--field-border)] rounded-lg text-[var(--text)] text-lg ' +
  'placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]';

export interface FormFieldProps {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}

export function FormField({ id, label, hint, children }: FormFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-[var(--text)] text-lg font-semibold mb-2">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-sm text-[var(--text-tertiary)]">{hint}</p>}
    </div>
  );
}
