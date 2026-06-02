export type SoilTone = 'wet' | 'moist' | 'dry';

export interface SoilStatusVisual {
  tone: SoilTone;
  colorVar: string;
  labelKey: string;
}

const SOIL_STATUS_VISUALS: Record<string, SoilStatusVisual> = {
  wet_excess: { tone: 'wet', colorVar: 'var(--soil-wet)', labelKey: 'history.soil.state.wet' },
  optimal: { tone: 'moist', colorVar: 'var(--soil-moist)', labelKey: 'history.soil.state.moist' },
  dry_stress: { tone: 'dry', colorVar: 'var(--soil-dry)', labelKey: 'history.soil.state.dry' },
};

export function soilStatusVisual(status: string | null | undefined): SoilStatusVisual | null {
  if (!status) return null;
  return SOIL_STATUS_VISUALS[status] ?? null;
}
