import React, {Suspense} from 'react';
import ReactDOM from 'react-dom/client';
import {useTranslation} from 'react-i18next';
import App from '../src/App';
import {LanguageSwitcher} from '../src/components/LanguageSwitcher';
import '../src/index.css';
import './app.css';
import {applyThemePreference} from '../src/utils/displayPreferences';
function DemoApp() {
  const {i18n} = useTranslation();
  return <><div className="demo-language"><span>{i18n.language === 'fr' ? 'MUARIK · Ferme simulée' : 'MUARIK · Simulated farm'}</span><LanguageSwitcher /></div><App /></>;
}
applyThemePreference('light');
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Suspense fallback="Loading OSI OS…"><DemoApp /></Suspense></React.StrictMode>);
