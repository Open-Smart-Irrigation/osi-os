type Recommendation = {date?: unknown; irrigation_action?: unknown; action_reasoning?: unknown};

function finite(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Browser-safe port of osi-zone-env::resolveWaterAction for the public simulator. */
export function resolveWaterAction(today: string, recommendation: Recommendation | null,
  balanceTodayMm: unknown, next24hRainMm: unknown, waterNeededTodayMm: unknown) {
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
  if (recommendation) return {code: text(recommendation.irrigation_action), source: 'dendro', reasonCode: null,
    reasoning: text(recommendation.action_reasoning), recommendationDate: text(recommendation.date) ?? today};
  const insufficient = (reasonCode: string) => ({code: null, source: 'insufficient_data', reasonCode, recommendationDate: today});
  const heuristic = (code: string, reasonCode: string) => ({code, source: 'heuristic', reasonCode, recommendationDate: today});
  const balance = finite(balanceTodayMm);
  if (balance == null && waterNeededTodayMm !== undefined && finite(waterNeededTodayMm) == null) return insufficient('demand_unknown');
  if (balance == null) return insufficient('balance_unknown');
  if (balance >= 0) return heuristic('delay_irrigation', 'supply_covers_demand');
  const shortfall = -balance;
  const forecastRain = finite(next24hRainMm);
  if (forecastRain == null) return insufficient('forecast_unknown');
  if (forecastRain >= shortfall) return heuristic('delay_irrigation', 'forecast_rain_covers_demand');
  if (balance <= -1) return heuristic('irrigate_today', 'demand_exceeds_supply');
  return heuristic('monitor_today', 'balance_neutral');
}
