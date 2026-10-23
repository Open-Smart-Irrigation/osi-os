import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartHost } from './ChartHost';
import { candidateFromHash, loadAdapter, routeFromHash, type AppRoute } from './routes';
import { PilotApp } from './pilot/PilotApp';
import { createFixtureLoader } from './shared/loading';
import { fixtureSeries } from './shared/fixtures';
import { createViewportStore } from './shared/viewport';
import { FIXTURE_EXTENT, INITIAL_VIEWPORT, SERIES_COLORS, type Candidate, type FixtureKind, type HistoryZoomProbe, type SensorSeries } from './shared/types';

export function App() {
  const readRoute = (): AppRoute => routeFromHash();
  const [appRoute, setAppRoute] = useState<AppRoute>(() => readRoute());
  useEffect(() => {
    const onHash = () => setAppRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (appRoute.kind === 'pilot') return <PilotApp key={appRoute.platform} platform={appRoute.platform} />;
  return <CandidateApp initialCandidate={appRoute.candidate} />;
}

function CandidateApp({ initialCandidate }: { initialCandidate: Candidate }) {
  const store = useMemo(() => createViewportStore(INITIAL_VIEWPORT, FIXTURE_EXTENT), []);
  const loaderRef = useRef<ReturnType<typeof createFixtureLoader> | null>(null);
  const requestGenerationRef = useRef(0);
  const [route, setRoute] = useState<Candidate>(initialCandidate);
  const [mountAdapter, setMountAdapter] = useState<import('./shared/types').MountAdapter | null>(null);
  const [mountAdapterRoute, setMountAdapterRoute] = useState<Candidate | null>(null);
  const [series, setSeries] = useState<readonly SensorSeries[]>(() => fixtureSeries('nominal'));
  const [fixture, setFixture] = useState<FixtureKind>('nominal');
  const [pendingFixture, setPendingFixture] = useState<FixtureKind | null>(null);
  const [acceptedFixture, setAcceptedFixture] = useState<FixtureKind>('nominal');
  const [delay, setDelay] = useState(0);
  const [probe, setProbe] = useState<HistoryZoomProbe | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adapterError, setAdapterError] = useState<string | null>(null);

  useEffect(() => { setRoute(initialCandidate); }, [initialCandidate]);
  useEffect(() => {
    let active = true;
    setMountAdapter(null);
    setMountAdapterRoute(null);
    setProbe(null);
    setAdapterError(null);
    void loadAdapter(route).then((adapter) => { if (active) { setMountAdapter(() => adapter); setMountAdapterRoute(route); } }).catch((error: unknown) => {
      if (active) setAdapterError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [route]);
  useEffect(() => {
    const loader = createFixtureLoader();
    loaderRef.current = loader;
    return () => {
      requestGenerationRef.current += 1;
      loader.destroy();
      if (loaderRef.current === loader) loaderRef.current = null;
    };
  }, []);

  const chooseCandidate = (candidate: Candidate) => { window.location.hash = `#/${candidate}`; };
  const diagnosticsProbe = mountAdapter && mountAdapterRoute === route && probe === window.__historyZoomProbe ? probe : null;
  const load = () => {
    const loader = loaderRef.current;
    if (!loader) return;
    const requestGeneration = ++requestGenerationRef.current;
    const requestedFixture = fixture;
    setLoading(true);
    setPendingFixture(requestedFixture);
    setLoadError(null);
    void loader.load(requestedFixture, delay, (next) => {
      if (requestGeneration !== requestGenerationRef.current) return;
      setSeries(next);
      setAcceptedFixture(requestedFixture);
    }).then((applied) => {
      if (requestGeneration === requestGenerationRef.current && !applied) setLoadError('Fixture request was superseded.');
    }).catch((error: unknown) => {
      if (requestGeneration === requestGenerationRef.current) setLoadError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (requestGeneration === requestGenerationRef.current) setLoading(false);
    });
  };
  const reset = () => store.set(INITIAL_VIEWPORT, 'external');

  return <main className="app-shell">
    <header className="page-header">
      <p className="eyebrow">History comparison lab</p>
      <h1>Mobile history zoom</h1>
      <p className="lede">Compare gesture behavior against the same synthetic soil-water history.</p>
    </header>
    <nav className="candidate-nav" aria-label="Chart candidates">
      {(['echarts', 'uplot', 'chartjs'] as const).map((candidate) => <button key={candidate} type="button" data-testid={`candidate-${candidate}`} aria-pressed={route === candidate} onClick={() => chooseCandidate(candidate)}>{candidate}</button>)}
    </nav>
    <section className="controls" aria-label="Fixture controls">
      <label>Fixture <select data-testid="fixture-select" value={fixture} onChange={(event) => setFixture(event.target.value as FixtureKind)}><option value="nominal">Nominal</option><option value="sparse">Sparse</option><option value="stress">Stress</option><option value="empty">Empty</option><option value="single">Single</option></select></label>
      <label>Load delay (ms) <input data-testid="load-delay-ms" type="number" min="0" value={delay} onChange={(event) => setDelay(Math.max(0, Number(event.target.value) || 0))} /></label>
      <button type="button" data-testid="load-fixture" onClick={load}>{loading ? 'Loading…' : 'Load fixture'}</button>
      <button type="button" data-testid="reset-viewport" onClick={reset}>Reset view</button>
    </section>
    <p className="load-status" role="status" aria-live="polite">{loading ? `Loading ${pendingFixture ?? fixture} fixture…` : `Showing ${acceptedFixture} fixture`}</p>
    <p data-testid="accepted-fixture">Accepted fixture: {acceptedFixture}</p>
    <p data-testid="point-count">Point count: {series.reduce((total, item) => total + item.points.length, 0)}</p>
    {loadError && <p role="alert">Unable to load fixture: {loadError}</p>}
    <section className="legend" aria-label="Series legend">{series.map((item, index) => <span key={item.id}><i style={{ backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length] }} />{item.label}</span>)}<span className="unit-label">kPa</span></section>
    <section className="chart-section">
      {mountAdapter && mountAdapterRoute === route ? <ChartHost route={route} mountAdapter={mountAdapter} series={series} store={store} onDiagnostics={(next) => { setProbe(next); window.__historyZoomProbe = next; }} /> : <div className="candidate-unavailable">{adapterError ? `Candidate unavailable: ${adapterError}` : 'Candidate unavailable: adapter not implemented'}</div>}
    </section>
    <details className="diagnostics"><summary>Diagnostics</summary><pre data-testid="diagnostics">{diagnosticsProbe ? JSON.stringify({ route: diagnosticsProbe.route, requestedViewport: diagnosticsProbe.requestedViewport, renderedViewport: diagnosticsProbe.renderedViewport, adapterSetViewportCalls: diagnosticsProbe.adapterSetViewportCalls, viewportNotifications: diagnosticsProbe.viewportNotifications, reactRenderCount: diagnosticsProbe.reactRenderCount }, null, 2) : 'Waiting for adapter'}</pre></details>
    <p className="footer-copy">Synthetic data keeps the comparison repeatable. Scroll beyond the chart to test geometry refresh while the page remains usable on a phone.</p>
  </main>;
}
