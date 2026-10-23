import type { PilotPlatform, PilotPlatformConfig } from './types';

const CONFIG: Record<PilotPlatform, PilotPlatformConfig> = {
  edge: { historyPrefix: '/api/history', zonesPath: '/api/irrigation-zones', loginPath: '/gui/#/login' },
  cloud: { historyPrefix: '/api/v1/history', zonesPath: '/api/v1/irrigation-zones', loginPath: '/login' },
};

export function platformConfig(platform: PilotPlatform): PilotPlatformConfig {
  if (platform !== 'edge' && platform !== 'cloud') throw new Error('Unknown pilot platform');
  return CONFIG[platform];
}
