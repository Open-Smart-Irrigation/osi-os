import React, {Component, Suspense, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {SWRConfig} from 'swr';
import App from '../../../react-gui/src/App';
import '../../../react-gui/src/index.css';
import {applyThemePreference, readDisplayPreferences} from '../../../react-gui/src/utils/displayPreferences';
import {demoRevalidation} from '@osi-demo/revalidation';
import './phone.css';

class StartupBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};

  static getDerivedStateFromError() {
    return {failed: true};
  }

  render() {
    return this.state.failed ? <p role="alert">OSI OS could not start.</p> : this.props.children;
  }
}

export function mountPhone(root: HTMLElement, isVisible: () => boolean): void {
  applyThemePreference(readDisplayPreferences().theme);
  createRoot(root).render(
    <React.StrictMode>
      <Suspense fallback="Loading OSI OS…">
        <SWRConfig value={{use: [demoRevalidation], isVisible}}>
          <StartupBoundary><App /></StartupBoundary>
        </SWRConfig>
      </Suspense>
    </React.StrictMode>,
  );
}
