import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'liquid' | 'liquid-red';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] font-bold rounded-lg transition-colors ' +
    'disabled:bg-[var(--border)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed',
  secondary:
    'bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold rounded-lg transition-colors',
  liquid: 'btn-liquid rounded-lg font-bold text-[var(--text)]',
  'liquid-red': 'btn-liquid-red rounded-lg font-bold disabled:cursor-not-allowed',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className = '', type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`touch-target ${VARIANT_CLASSES[variant]} ${className}`.trim()} {...rest} />;
}
