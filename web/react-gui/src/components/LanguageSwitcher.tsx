import React from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '../i18n/config';

export const LanguageSwitcher: React.FC = () => {
  const { i18n } = useTranslation();
  return (
    <select
      value={i18n.language}
      onChange={(e) => i18n.changeLanguage(e.target.value)}
      className="bg-slate-700 border-2 border-slate-600 text-white rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none focus:border-farm-green"
      aria-label="Select language"
    >
      {SUPPORTED_LANGUAGES.map(({ code, label }) => (
        <option key={code} value={code}>{label}</option>
      ))}
    </select>
  );
};
