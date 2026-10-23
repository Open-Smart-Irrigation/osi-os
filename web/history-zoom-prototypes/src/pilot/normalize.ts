import type { PilotAcceptedData, PilotCard, PilotRangeRequest, PilotZone } from './types';
import { PilotResponseError } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const valueAt = (row: Record<string, unknown>, ...keys: string[]) => keys.map((key) => row[key]).find((value) => value !== undefined);
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
function rows(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw[key])) return raw[key];
  throw new PilotResponseError(`Malformed ${key} response`);
}
export function normalizeZones(raw: unknown): PilotZone[] {
  return rows(raw, 'zones').flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = valueAt(item, 'id', 'zoneId', 'zone_id');
    const name = valueAt(item, 'name', 'zoneName', 'zone_name');
    return typeof id === 'number' && Number.isInteger(id) && id > 0 && typeof name === 'string' && name.trim() ? [{ id, name: name.trim() }] : [];
  });
}
export function normalizeCards(raw: unknown): PilotCard[] {
  return rows(raw, 'cards').flatMap((item) => {
    if (!isRecord(item)) return [];
    const cardId = valueAt(item, 'cardId', 'card_id');
    if (typeof cardId !== 'string' || !cardId.trim()) return [];
    const views = Array.isArray(item.views) ? item.views.filter((view): view is string => typeof view === 'string') : [];
    const availability = isRecord(item.availability) ? item.availability.available : undefined;
    const source = valueAt(item, 'sourceLabels', 'source_labels');
    return [{ cardId: cardId.trim(), cardType: typeof item.cardType === 'string' ? item.cardType : typeof item.card_type === 'string' ? item.card_type : '', title: typeof item.title === 'string' ? item.title : cardId.trim(), views, sourceLabels: Array.isArray(source) ? source.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [], available: views.includes('line-chart') && availability === true }];
  });
}
function instant(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}
export function normalizeCardData(raw: unknown, request: PilotRangeRequest): PilotAcceptedData {
  if (!isRecord(raw) || !Array.isArray(raw.series)) throw new PilotResponseError('Malformed history response');
  const cardId = typeof raw.cardId === 'string' ? raw.cardId : typeof raw.card_id === 'string' ? raw.card_id : '';
  if (!cardId) throw new PilotResponseError('History response has no card id');
  const range = isRecord(raw.range) ? raw.range : {};
  const responseFrom = instant(valueAt(range, 'from'));
  const responseTo = instant(valueAt(range, 'to'));
  const from = responseFrom !== null && responseTo !== null && responseFrom < responseTo ? Math.max(request.from, responseFrom) : request.from;
  const to = responseFrom !== null && responseTo !== null && responseFrom < responseTo ? Math.min(request.to, responseTo) : request.to;
  if (from >= to) throw new PilotResponseError('History response range is empty');
  const series = raw.series.flatMap((item): PilotAcceptedData['series'][number][] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !Array.isArray(item.points)) return [];
    const points = new Map<number, number | null>();
    for (const point of item.points) {
      if (!isRecord(point)) continue;
      const t = instant(point.t);
      if (t === null) continue;
      let value: number | null;
      if (Object.prototype.hasOwnProperty.call(point, 'value')) value = number(point.value);
      else {
        value = null;
        for (const key of ['latest', 'mean', 'median']) {
          const candidate = number(point[key]);
          if (candidate !== null) { value = candidate; break; }
        }
      }
      points.set(t, value);
    }
    const unitValue = typeof item.unit === 'string' ? item.unit.trim() : '';
    return [{ id: item.id, label: typeof item.label === 'string' ? item.label : item.id, unit: unitValue, points: [...points.entries()].sort(([a], [b]) => a - b).map(([t, value]) => ({ t, value })) }];
  });
  const unitGroups = [...new Set(series.map((item) => item.unit))].map((unit) => ({ unit, label: unit || 'Unit not reported', seriesIds: series.filter((item) => item.unit === unit).map((item) => item.id) }));
  const aggregation = isRecord(raw.aggregation) ? raw.aggregation : {};
  if (!isRecord(raw.limits)) throw new PilotResponseError('Malformed history limits');
  const limits = raw.limits;
  const maxPointsPerSeries = valueAt(limits, 'maxPointsPerSeries', 'max_points_per_series');
  if (typeof maxPointsPerSeries !== 'number' || !Number.isFinite(maxPointsPerSeries) || maxPointsPerSeries <= 0 || typeof limits.truncated !== 'boolean') throw new PilotResponseError('Malformed history limits');
  return { cardId, request, coverage: { from, to }, series, unitGroups, aggregation: { level: typeof aggregation.level === 'string' ? aggregation.level : 'unknown', pointCount: number(valueAt(aggregation, 'pointCount', 'point_count')) ?? series.reduce((total, item) => total + item.points.length, 0) }, limits: { maxPointsPerSeries, truncated: limits.truncated } };
}
