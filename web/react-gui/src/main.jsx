import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './i18n/config.ts'
import './index.css'
import './fonts/noto-sans.css'
import { applyThemePreference, readDisplayPreferences } from './utils/displayPreferences.ts'

applyThemePreference(readDisplayPreferences().theme)

if (typeof window.matchMedia === 'function') {
  const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const reapplySystemTheme = () => {
    if (readDisplayPreferences().theme === 'system') {
      applyThemePreference('system')
    }
  }

  if (typeof systemThemeQuery.addEventListener === 'function') {
    systemThemeQuery.addEventListener('change', reapplySystemTheme)
  } else if (typeof systemThemeQuery.addListener === 'function') {
    systemThemeQuery.addListener(reapplySystemTheme)
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Suspense fallback={<div className="min-h-screen bg-[var(--bg)]" />}>
      <App />
    </Suspense>
  </React.StrictMode>
)
