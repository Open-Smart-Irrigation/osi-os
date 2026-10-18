import {useEffect} from 'react';
import type {Cache, Middleware, ScopedMutator, SWRConfiguration} from 'swr';

// The app keeps its SWR cache per authentication epoch (#378), so SWR's
// process-global `mutate` no longer reaches the cache the app renders from.
// The simulator asks the mounted hooks instead: every hook registers this
// middleware through the SWRConfig around <App />, and the first hook of a
// cache to see a request revalidates the listed keys with that cache's own
// scoped mutate, once per cache and request.
const DEMO_REVALIDATE_EVENT = 'osi-demo:revalidate';

type DemoRevalidation = {keys: readonly string[]; handled: WeakSet<Cache>};

export function requestDemoRevalidation(keys: readonly string[]): void {
  window.dispatchEvent(new CustomEvent<DemoRevalidation>(DEMO_REVALIDATE_EVENT, {detail: {keys, handled: new WeakSet()}}));
}

export const demoRevalidation: Middleware = useSWRNext => (key, fetcher, config) => {
  const {cache, mutate} = config as SWRConfiguration & {cache: Cache; mutate: ScopedMutator};
  useEffect(() => {
    const handler = (event: Event) => {
      const {keys, handled} = (event as CustomEvent<DemoRevalidation>).detail;
      if (handled.has(cache)) return;
      handled.add(cache);
      for (const changed of keys) void mutate(changed);
    };
    window.addEventListener(DEMO_REVALIDATE_EVENT, handler);
    return () => window.removeEventListener(DEMO_REVALIDATE_EVENT, handler);
  }, [cache, mutate]);
  return useSWRNext(key, fetcher, config);
};
