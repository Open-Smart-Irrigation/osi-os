import type { SeriesAppearance } from './types';

const APPEARANCES: readonly SeriesAppearance[] = [
  { color: '#3271bc', dash: [], marker: 'circle' },
  { color: '#a16a32', dash: [7, 4], marker: 'square' },
  { color: '#087c60', dash: [2, 4], marker: 'triangle' },
  { color: '#b45447', dash: [], marker: 'diamond' },
  { color: '#7955a0', dash: [7, 4], marker: 'circle' },
  { color: '#4e7570', dash: [2, 4], marker: 'square' },
  { color: '#9c7016', dash: [], marker: 'triangle' },
  { color: '#47758d', dash: [7, 4], marker: 'diamond' },
  { color: '#945567', dash: [2, 4], marker: 'circle' },
  { color: '#587c39', dash: [], marker: 'square' },
  { color: '#785c41', dash: [7, 4], marker: 'triangle' },
  { color: '#485e92', dash: [2, 4], marker: 'diamond' },
];

export function getSeriesAppearance(index: number): SeriesAppearance {
  return APPEARANCES[((index % APPEARANCES.length) + APPEARANCES.length) % APPEARANCES.length];
}
