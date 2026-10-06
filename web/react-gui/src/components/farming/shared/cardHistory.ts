// Shared pieces of the card history view: a value on a device card is a button
// that opens SensorMonitor for one series of that device.

// Series keys GET /api/devices/:deveui/sensor-history serves for the cards that
// build keys at run time or were added later (WATERMARK, SDI-12, LoRain, STREGA).
// The route answers through osi-history-helper.legacySensorHistory and rejects
// any other key with 400; cardHistorySeries.test.ts checks this list against that
// helper, so a card never offers a history the gateway would refuse.
export const CARD_HISTORY_SERIES_KEYS: ReadonlySet<string> = new Set([
  'swt_1', 'swt_2', 'swt_3',
  ...Array.from({ length: 10 }, (_, i) => `vwc_${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `soil_vic_${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `soil_temp_${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `soil_ec_${i + 1}`),
  'ext_temperature_c',
  'ambient_temperature',
  'relative_humidity',
  'rain_mm_delta',
  'rain_mm_per_10min',
  'rain_mm_today',
]);

export function isCardHistorySeriesKey(key: string): boolean {
  return CARD_HISTORY_SERIES_KEYS.has(key);
}

export interface CardHistorySeries {
  field: string;
  label: string;
  unit: string;
  color?: string;
  decimals?: number;
}

export interface CardHistoryRequest extends CardHistorySeries {
  initialField?: string;
  seriesOptions?: CardHistorySeries[];
}

export const FOCUS_VISIBLE_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]';

// The legacy cue for "this value opens its history": dotted underline, primary on hover.
export const HISTORY_VALUE_CUE = 'cursor-pointer underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]';
