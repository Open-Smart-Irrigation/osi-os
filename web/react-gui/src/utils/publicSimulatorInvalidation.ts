type SimulatorRevalidation = {keys?: readonly string[]};

/** Subscribe imperative readers to the simulator's public-only invalidation event. */
export function subscribePublicSimulatorInvalidation(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined'
    || document.documentElement.dataset.publicSimulator !== 'true') return () => undefined;
  const handle = (event: Event) => {
    const keys = (event as CustomEvent<SimulatorRevalidation>).detail?.keys;
    if (!keys || keys.includes('*')) listener();
  };
  window.addEventListener('osi-demo:revalidate', handle);
  return () => window.removeEventListener('osi-demo:revalidate', handle);
}
