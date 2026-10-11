export const CHANNEL = 'osi-mobile-simulator-v1';
export const DEMO_LANGUAGES = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'] as const;
export type DemoLanguage = typeof DEMO_LANGUAGES[number];
export type HostCommand =
  | {channel: typeof CHANNEL; type: 'active'; value: boolean}
  | {channel: typeof CHANNEL; type: 'speed'; value: 1 | 10 | 60}
  | {channel: typeof CHANNEL; type: 'next-event'};
export type AppMessage =
  | {channel: typeof CHANNEL; type: 'ready'}
  | {channel: typeof CHANNEL; type: 'focus'}
  | {channel: typeof CHANNEL; type: 'notice'; message: string}
  | {channel: typeof CHANNEL; type: 'language'; value: DemoLanguage}
  | {channel: typeof CHANNEL; type: 'startup-error'; message: string}
  | {channel: typeof CHANNEL; type: 'time'; value: number};

export function isDemoLanguage(value: unknown): value is DemoLanguage {
  return typeof value === 'string' && (DEMO_LANGUAGES as readonly string[]).includes(value);
}

export function isHostCommand(value: unknown): value is HostCommand {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.channel !== CHANNEL) return false;
  if (v.type === 'next-event') return Object.keys(v).length === 2;
  return Object.keys(v).length === 3 &&
    ((v.type === 'active' && typeof v.value === 'boolean') || (v.type === 'speed' && [1, 10, 60].includes(v.value as number)));
}

export function isAppMessage(value: unknown): value is AppMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.channel !== CHANNEL) return false;
  if (v.type === 'ready' || v.type === 'focus') return Object.keys(v).length === 2;
  if (v.type === 'language') return Object.keys(v).length === 3 && isDemoLanguage(v.value);
  if (v.type === 'time') return Object.keys(v).length === 3 && typeof v.value === 'number' && Number.isFinite(v.value);
  return Object.keys(v).length === 3 && (v.type === 'notice' || v.type === 'startup-error') &&
    typeof v.message === 'string' && v.message.length <= 600;
}
