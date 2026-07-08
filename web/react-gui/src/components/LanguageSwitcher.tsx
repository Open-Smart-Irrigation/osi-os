import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '../i18n/config';

interface LanguageSwitcherProps {
  triggerClassName?: string;
  menuAlign?: 'left' | 'right';
}

const DEFAULT_TRIGGER_CLASS = 'px-3 py-2 text-sm';

export const LanguageSwitcher: React.FC<LanguageSwitcherProps> = ({ triggerClassName, menuAlign = 'right' }) => {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const language = i18n.language ?? 'en';
  const current = SUPPORTED_LANGUAGES.find((candidate) => candidate.code === language)
    ?? SUPPORTED_LANGUAGES.find((candidate) => language.startsWith(candidate.code))
    ?? SUPPORTED_LANGUAGES[0];

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const select = (code: string) => {
    i18n.changeLanguage(code);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`flex items-center gap-1.5 rounded-lg bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-semibold transition-colors ${triggerClassName ?? DEFAULT_TRIGGER_CLASS}`}
        title="Change language"
      >
        {current.label}
        <span aria-hidden="true" className="text-xs opacity-60">{open ? '^' : 'v'}</span>
      </button>

      {open && (
        <div className={`absolute top-full z-50 mt-1 min-w-[160px] rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-xl ${menuAlign === 'left' ? 'left-0' : 'right-0'}`}>
          {SUPPORTED_LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              type="button"
              onClick={() => select(lang.code)}
              className={`w-full px-4 py-2 text-left text-sm transition-colors ${
                lang.code === current.code
                  ? 'bg-[var(--primary)] font-semibold text-white'
                  : 'text-[var(--text)] hover:bg-[var(--card)]'
              }`}
            >
              {lang.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
