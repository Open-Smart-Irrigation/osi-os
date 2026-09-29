import React, {Suspense} from 'react';
import ReactDOM from 'react-dom/client';
import App from '../src/App';
import '../src/index.css';
import './app.css';
import {applyThemePreference} from '../src/utils/displayPreferences';
applyThemePreference('light');
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Suspense fallback="Loading OSI OS…"><App /></Suspense></React.StrictMode>);
