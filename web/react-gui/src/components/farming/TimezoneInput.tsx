import { useId } from 'react';
import type { ChangeEvent } from 'react';

export interface TimezoneInputProps {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

// Shared timezone control used by both ZoneConfigModal (per-zone timezone) and the
// Settings page's gateway-level default. A plain free-text IANA time zone field
// (e.g. "Europe/Rome") — there is no fixed options list to pick from, so this is
// intentionally an <input>, not a <select>.
export function TimezoneInput({ id, label, value, onChange, placeholder = 'e.g. Europe/Rome', disabled }: TimezoneInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div>
      <label htmlFor={inputId} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        value={value}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)] disabled:opacity-60"
      />
    </div>
  );
}
