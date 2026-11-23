import React, {Component, Suspense, useEffect, type ErrorInfo, type ReactNode} from 'react';
import ReactDOM from 'react-dom/client';
import {SWRConfig} from 'swr';
import App from '../src/App';
import '../src/index.css';
import './app.css';
import {applyThemePreference} from '../src/utils/displayPreferences';
import {demoRevalidation} from './revalidation';
import {CHANNEL} from './protocol';
import i18n from './i18n';
import {normalizeDemoLanguage} from './public/messages';

const publicMode = import.meta.env.VITE_PUBLIC_SIMULATOR === 'true';

function PublicMountReady() {
  useEffect(() => {
    const syncDocumentLanguage = (language: string) => {document.documentElement.lang = normalizeDemoLanguage(language);};
    const language = normalizeDemoLanguage(i18n.resolvedLanguage ?? i18n.language);
    syncDocumentLanguage(language);
    i18n.on('languageChanged', syncDocumentLanguage);
    parent.postMessage({channel: CHANNEL, type: 'language', value: language}, location.origin);
    parent.postMessage({channel: CHANNEL, type: 'time', value: Date.now(), timeZone: 'Africa/Kampala'}, location.origin);
    parent.postMessage({channel: CHANNEL, type: 'ready'}, location.origin);
    return () => {i18n.off('languageChanged', syncDocumentLanguage);};
  }, []);
  return null;
}

class StartupErrorBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError(): {failed: boolean} {return {failed: true};}
  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    if (publicMode) parent.postMessage({channel: CHANNEL, type: 'startup-error', message: 'OSI OS could not start.'}, location.origin);
  }
  render() {return this.state.failed ? null : this.props.children;}
}

applyThemePreference('light');
const DEMO_SWR_CONFIG = {use: [demoRevalidation]};
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback="Loading OSI OS…">
      <SWRConfig value={DEMO_SWR_CONFIG}>
        {publicMode ? <StartupErrorBoundary><><App /><PublicMountReady /></></StartupErrorBoundary> : <App />}
      </SWRConfig>
    </Suspense>
  </React.StrictMode>,
);
