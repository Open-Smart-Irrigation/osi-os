import React from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '../i18n/config';
import { HeaderMenu } from './HeaderMenu';

interface LanguageSwitcherProps {
  triggerClassName?: string;
  menuAlign?: 'left' | 'right';
}

export const LanguageSwitcher: React.FC<LanguageSwitcherProps> = ({ triggerClassName, menuAlign = 'right' }) => {
  const { i18n } = useTranslation('common');
  const language = i18n.language ?? 'en';
  const current = SUPPORTED_LANGUAGES.find(candidate => candidate.code === language)
    ?? SUPPORTED_LANGUAGES.find(candidate => language.startsWith(candidate.code))
    ?? SUPPORTED_LANGUAGES[0];
  return <HeaderMenu label={current.label} align={menuAlign}
    triggerClassName={`bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] ${triggerClassName ?? 'px-3 py-2 text-sm'}`}
    items={SUPPORTED_LANGUAGES.map(lang => ({key: lang.code, label: lang.label, onSelect: () => { void i18n.changeLanguage(lang.code); }}))} />;
};
