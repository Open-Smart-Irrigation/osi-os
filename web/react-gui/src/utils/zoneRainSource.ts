// The zone's rain gauge selection as GET /api/irrigation-zones/:id/rain-source
// answers it. One gauge measures a zone's rain; when two or more report for it
// the zone is ambiguous until the operator chooses one (the gateway never adds
// two gauges). The suggestion is the field journal's gauge order, shown for the
// operator to confirm, never applied by itself.

export type ZoneRainSourceState = 'selected' | 'ambiguous' | 'none';
export type ZoneRainSourceBasis = 'explicit' | 'only_candidate';
export type ZoneRainGaugeVia = 'direct' | 'weather_station';

export interface ZoneRainGaugeCandidate {
  deveui: string;
  name: string | null;
  typeId: string | null;
  via: ZoneRainGaugeVia;
}

export interface ZoneRainSource {
  state: ZoneRainSourceState;
  selectedDeveui: string | null;
  basis: ZoneRainSourceBasis | null;
  candidates: ZoneRainGaugeCandidate[];
  suggestedDeveui: string | null;
}

const STATES: readonly ZoneRainSourceState[] = ['selected', 'ambiguous', 'none'];
const BASES: readonly ZoneRainSourceBasis[] = ['explicit', 'only_candidate'];

function euiOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseCandidate(row: unknown): ZoneRainGaugeCandidate | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;
  const deveui = euiOrNull(record.deveui);
  if (!deveui) return null;
  return {
    deveui,
    name: textOrNull(record.name),
    typeId: textOrNull(record.type_id),
    via: record.via === 'weather_station' ? 'weather_station' : 'direct',
  };
}

export function normaliseZoneRainSource(raw: unknown): ZoneRainSource {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const state = (STATES as readonly unknown[]).includes(record.state) ? (record.state as ZoneRainSourceState) : 'none';
  const basis = (BASES as readonly unknown[]).includes(record.basis) ? (record.basis as ZoneRainSourceBasis) : null;
  const candidates = Array.isArray(record.candidates)
    ? record.candidates.map(parseCandidate).filter((c): c is ZoneRainGaugeCandidate => c !== null)
    : [];
  return {
    state,
    selectedDeveui: euiOrNull(record.selected_deveui),
    basis,
    candidates,
    suggestedDeveui: euiOrNull(record.suggested_deveui),
  };
}

/** The select's starting value: the operator's own choice, else none. */
export function initialRainGaugeChoice(source: ZoneRainSource | null): string {
  return source && source.basis === 'explicit' && source.selectedDeveui ? source.selectedDeveui : '';
}
