import type {ZoneEnvironmentSummary} from '../../../react-gui/src/types/farming';
import type {DemoResponse} from '../core/osi/types';
import type {GameRefusal} from './copy';

const SUMMARY = /^\/api\/irrigation-zones\/\d+\/environment-summary$/;

export function wrapPhoneRequest(
  request: (method: string, path: string, body: unknown) => DemoResponse,
  currentConditions: () => string,
  refusalText: (code: GameRefusal) => string,
) {
  return (method: string, path: string, body?: unknown): DemoResponse => {
    const response = structuredClone(request(method, path, body));
    if (!response.data || typeof response.data !== 'object') return response;

    if (response.status === 403) {
      const error = response.data as {error?: unknown; message?: string};
      if (error.error === 'game_refused' || error.error === 'game_tier') {
        error.message = refusalText(error.error);
      }
    }

    if (response.status >= 200 && response.status < 300 && method === 'GET' && SUMMARY.test(path.split('?')[0])) {
      const {online, forecast} = response.data as ZoneEnvironmentSummary;
      if (online.current) online.current.description = currentConditions();
      for (const day of forecast.rainFocus?.daily ?? []) {
        if (day.rainMm != null) day.description = day.rainMm >= 0.05 ? 'rain' : 'clear';
      }
    }
    return response;
  };
}
