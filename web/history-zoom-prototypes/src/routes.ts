import type { Candidate, MountAdapter } from './shared/types';

export type AppRoute =
  | { kind: 'candidate'; candidate: Candidate }
  | { kind: 'pilot'; platform: 'edge' | 'cloud' };

export const candidates: readonly Candidate[] = ['echarts', 'uplot', 'chartjs'];
const paths: Record<Candidate, string> = {
  echarts: './adapters/echarts.ts',
  uplot: './adapters/uplot.ts',
  chartjs: './adapters/chartjs.ts',
};

const modules = import.meta.glob<{ default: MountAdapter }>([
  './adapters/echarts.ts',
  './adapters/uplot.ts',
  './adapters/chartjs.ts',
]);

export function candidateFromHash(hash = window.location.hash): Candidate {
  const value = hash.replace(/^#\/?/, '').split('/')[0];
  if (candidates.includes(value as Candidate)) return value as Candidate;
  if (hash === window.location.hash) window.history.replaceState(null, '', '#/uplot');
  return 'uplot';
}

export function routeFromHash(hash = window.location.hash): AppRoute {
  const value = hash.replace(/^#\/?/, '').split('/');
  if (value[0] === 'pilot' && (value[1] === 'edge' || value[1] === 'cloud')) {
    return { kind: 'pilot', platform: value[1] };
  }
  const candidate = value[0] as Candidate;
  if (candidates.includes(candidate)) return { kind: 'candidate', candidate };
  if (hash === window.location.hash) window.history.replaceState(null, '', '#/uplot');
  return { kind: 'candidate', candidate: 'uplot' };
}

export async function loadAdapter(candidate: Candidate): Promise<MountAdapter | null> {
  const load = modules[paths[candidate]];
  return load ? (await load()).default : null;
}
