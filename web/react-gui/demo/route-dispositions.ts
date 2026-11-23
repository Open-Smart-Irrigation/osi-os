/**
 * Main-added API routes reviewed during the v1 simulator port. These records
 * name the simulator boundary honestly; they do not claim a complete API spec.
 */
export const MAIN_ROUTE_DISPOSITIONS = [
  {method: 'GET', path: '/api/irrigation-zones/:zone/irrigation-policy', disposition: 'simulated', reason: 'Read-only unqualified policy status mirrors the edge response envelope.'},
  {method: 'GET', path: '/api/irrigation-zones/:zone/irrigation-policy/decisions', disposition: 'simulated', reason: 'No conditional decisions are generated while qualification is unavailable.'},
  {method: 'PUT', path: '/api/irrigation-zones/:zone/irrigation-policy', disposition: 'simulated', reason: 'Enabled conditional schedules fail closed with the edge 503 qualification reason.'},
  {method: 'POST', path: '/api/irrigation-zones/:zone/irrigation-policy/pause', disposition: 'unsupported', reason: 'Policy pause cancellation and pending-command reconciliation are not simulated.'},
  {method: 'POST', path: '/api/irrigation-zones/:zone/irrigation-policy/retry-valve', disposition: 'unsupported', reason: 'Retry requires the conditional policy delivery lifecycle, which is not qualified.'},
  {method: 'GET', path: '/api/irrigation-zones/:zone/rain-source', disposition: 'simulated', reason: 'Read-only source candidates use the demo zone and weather-station assignments; selection is never written.'},
  {method: 'PUT', path: '/api/irrigation-zones/:zone/rain-source', disposition: 'unsupported', reason: 'Rain-source writes need the edge station-assignment store and actor audit.'},
  {method: 'POST', path: '/api/valve/:eui/cancel', disposition: 'simulated', reason: 'Uses the current edge queue cancellation distinction for pending and observed commands.'},
  {method: 'POST', path: '/api/valves/:eui/scheduler-status', disposition: 'simulated', reason: 'Updates local schedule status and leaves ONCE behavior source-compatible.'},
  {method: 'PUT', path: '/api/devices/:eui/strega/interval', disposition: 'simulated', reason: 'The interval setting has a deterministic local effect and source-shaped response.'},
  {method: 'PUT', path: '/api/devices/:eui/strega/model', disposition: 'simulated', reason: 'The model setting has a deterministic local effect and source-shaped response.'},
  {method: 'PUT', path: '/api/devices/:eui/strega/magnet', disposition: 'simulated', reason: 'The magnet setting has a deterministic local effect and source-shaped response.'},
  {method: 'PUT', path: '/api/devices/:eui/strega/timed-action', disposition: 'simulated', reason: 'Timed service actions have explicit deterministic movement and recovery behavior.'},
  {method: 'PUT', path: '/api/devices/:eui/strega/partial-opening', disposition: 'simulated', reason: 'Partial actions have explicit deterministic movement and recovery behavior.'},
  {method: 'PUT', path: '/api/devices/:eui/strega/flushing', disposition: 'simulated', reason: 'Flush actions have explicit deterministic movement and recovery behavior.'},
  {method: 'GET', path: '/api/users', disposition: 'denied', reason: 'User administration is protected by the public researcher permission boundary.'},
  {method: 'POST', path: '/api/users', disposition: 'denied', reason: 'User administration is protected by the public researcher permission boundary.'},
] as const;
