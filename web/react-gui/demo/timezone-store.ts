const listeners = new Set<() => void>();
let gatewayTimezone = 'Africa/Kampala';

export function getGatewayTimezone(): string { return gatewayTimezone; }

export function setGatewayTimezone(timezone: string): void {
  if (!timezone || timezone === gatewayTimezone) return;
  gatewayTimezone = timezone;
  for (const listener of [...listeners]) listener();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('osi-gateway-timezone'));
}

export function subscribeTimezone(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
