export const CHANNEL = 'osi-mobile-simulator-v1';
export type HostCommand = {channel: typeof CHANNEL; type: 'active'; value: boolean} | {channel: typeof CHANNEL; type: 'speed'; value: 1 | 10 | 60};
export function isHostCommand(value: unknown): value is HostCommand {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 3 && v.channel === CHANNEL &&
    ((v.type === 'active' && typeof v.value === 'boolean') || (v.type === 'speed' && [1, 10, 60].includes(v.value as number)));
}
