import { valvesAPI } from './api';
import { beginValveReading, completeValveReading } from './valveCommandHold';
import type { ValveSummary } from '../types/farming';

/**
 * The GET /api/valves fetcher every valve surface uses. Each success is a valve
 * reading: it releases an open hold that began before this request started
 * (services/valveCommandHold.ts). A failed request releases nothing.
 */
export async function fetchValveReading(): Promise<ValveSummary[]> {
  const request = beginValveReading();
  const valves = await valvesAPI.list();
  completeValveReading(request);
  return valves;
}
