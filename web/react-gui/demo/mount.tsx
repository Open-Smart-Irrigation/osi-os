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
    const language = normalizeDemoLanguage(i18n.resolvedLanguage ?? i18n.language);
    parent.postMessage({channel: CHANNEL, type: 'language', value: language}, location.origin);
    parent.postMessage({channel: CHANNEL, type: 'time', value: Date.now()}, location.origin);
    parent.postMessage({channel: CHANNEL, type: 'ready'}, location.origin);
  }, []);
  return null;
}

class StartupErrorBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError(): {failed: boolean} {return {failed: true};}
  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    if (publicMode) parent.postMessage({channel: CHANNEL, type: 'startup-error', message: 'The simulator could not start.'}, location.origin);
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
