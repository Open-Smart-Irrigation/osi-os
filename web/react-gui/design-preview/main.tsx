import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { IrrigationZoneCard } from '../src/components/farming/IrrigationZoneCard';
import i18n from '../src/i18n/config';
import { applyThemePreference, writeDisplayPreferences } from '../src/utils/displayPreferences';
import { NOW, previewDevices, zone, type Scenario } from './fixtures';
import '../src/index.css';
import './preview.css';

declare const __SWT_PREVIEW_MODE__: 'proposed' | 'implemented';
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const lang = ['en', 'de-CH', 'fr'].includes(params.get('lang') ?? '') ? params.get('lang')! : 'en';
const scenario = (['fresh', 'stale', 'fault', 'zero', 'future'].includes(params.get('scenario') ?? '')
  ? params.get('scenario') : 'fresh') as Scenario;
const unit = params.get('unit') === 'pF' ? 'pF' : 'kPa';
// Freeze only this isolated preview page, including the real cards' age labels.
Date.now = () => NOW;
document.documentElement.lang = lang;
applyThemePreference(theme);
writeDisplayPreferences({ swtUnit: unit, defaultTimezone: 'Europe/Zurich', modules: {
  environment: false, schedulerUi: false, predictionAdvisory: false, waterCard: true, valveControl: false,
} });

function control(key: string, value: string) {
  const next = new URL(location.href);
  next.searchParams.set(key, value);
  location.assign(next);
}

function App() {
  return (
    <>
      <header className="preview-toolbar">
        <div><strong>Soil water status</strong><p>Design preview · sample data · {__SWT_PREVIEW_MODE__ === 'proposed' ? 'proposed indicators' : 'implementation under test'}</p></div>
        <nav aria-label="Preview controls">
          <label>Theme<select value={theme} onChange={e => control('theme', e.target.value)}><option value="light">Light</option><option value="dark">Dark</option></select></label>
          <label>Language<select value={lang} onChange={e => control('lang', e.target.value)}><option value="en">English</option><option value="de-CH">Deutsch</option><option value="fr">Français</option></select></label>
          <label>Unit<select value={unit} onChange={e => control('unit', e.target.value)}><option>kPa</option><option>pF</option></select></label>
          <label>Readings<select value={scenario} onChange={e => control('scenario', e.target.value)}><option value="fresh">Current</option><option value="stale">4 hours old</option><option value="fault">Chameleon fault</option><option value="zero">Zero kPa</option><option value="future">Clock ahead</option></select></label>
        </nav>
      </header>
      <main className="preview-page">
        <p className="preview-note">The existing Zone B card and device sections. Expand the zone and its devices to inspect the indicators. Settings and history retain their existing controls; gateway writes are disabled in this preview.</p>
        <MemoryRouter>
          <IrrigationZoneCard zone={zone} devices={previewDevices(scenario)} unassignedDevices={[]} onUpdate={() => {}} />
        </MemoryRouter>
      </main>
    </>
  );
}

async function mount() {
  if (!i18n.isInitialized) await new Promise<void>(resolve => i18n.on('initialized', () => resolve()));
  await i18n.changeLanguage(lang);
  createRoot(document.getElementById('root')!).render(<Suspense fallback={<p>Loading preview…</p>}><App /></Suspense>);
}
void mount();
