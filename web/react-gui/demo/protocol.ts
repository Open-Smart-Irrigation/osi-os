export const CHANNEL = 'osi-mobile-simulator-v1';
export const DEMO_LANGUAGES = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'] as const;
export type DemoLanguage = typeof DEMO_LANGUAGES[number];
export type HostCommand =
  | {channel: typeof CHANNEL; type: 'active'; value: boolean}
  | {channel: typeof CHANNEL; type: 'speed'; value: 1 | 10 | 60}
  | {channel: typeof CHANNEL; type: 'next-event'}
  | {channel: typeof CHANNEL; type: 'guide'; step: GuideStep}
  | {channel: typeof CHANNEL; type: 'clear-guide'};
export type GuideStep = 'inspect-plot' | 'explain-advice' | 'history' | 'timed-irrigation' | 'skip-to-result' | 'result' | 'schedule' | 'next-steps';
export type AppMessage =
  | {channel: typeof CHANNEL; type: 'ready'}
  | {channel: typeof CHANNEL; type: 'focus'}
  | {channel: typeof CHANNEL; type: 'notice'; message: string}
  | {channel: typeof CHANNEL; type: 'language'; value: DemoLanguage}
  | {channel: typeof CHANNEL; type: 'startup-error'; message: string}
  | {channel: typeof CHANNEL; type: 'time'; value: number; timeZone: string}
  | {channel: typeof CHANNEL; type: 'next-event'; at: number | null; kind: 'valve-close' | 'schedule-start' | 'report' | null}
  | {channel: typeof CHANNEL; type: 'guide-result'; step: GuideStep; status: 'ready' | 'missing'};

export function isDemoLanguage(value: unknown): value is DemoLanguage {
  return typeof value === 'string' && (DEMO_LANGUAGES as readonly string[]).includes(value);
}

export function isHostCommand(value: unknown): value is HostCommand {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.channel !== CHANNEL) return false;
  if (v.type === 'next-event') return Object.keys(v).length === 2;
  if (v.type === 'guide') return Object.keys(v).length === 3 && ['inspect-plot', 'explain-advice', 'history', 'timed-irrigation', 'skip-to-result', 'result', 'schedule', 'next-steps'].includes(String(v.step));
  if (v.type === 'clear-guide') return Object.keys(v).length === 2;
  return Object.keys(v).length === 3 &&
    ((v.type === 'active' && typeof v.value === 'boolean') || (v.type === 'speed' && [1, 10, 60].includes(v.value as number)));
}

export function isAppMessage(value: unknown): value is AppMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.channel !== CHANNEL) return false;
  if (v.type === 'ready' || v.type === 'focus') return Object.keys(v).length === 2;
  if (v.type === 'language') return Object.keys(v).length === 3 && isDemoLanguage(v.value);
  if (v.type === 'time') return Object.keys(v).length === 4 && typeof v.value === 'number' && Number.isFinite(v.value) && typeof v.timeZone === 'string' && isIanaTimeZone(v.timeZone);
  if (v.type === 'next-event') return Object.keys(v).length === 4 && (v.at === null || (typeof v.at === 'number' && Number.isFinite(v.at))) && [null, 'valve-close', 'schedule-start', 'report'].includes(v.kind as string);
  if (v.type === 'guide-result') return Object.keys(v).length === 4 && ['inspect-plot', 'explain-advice', 'history', 'timed-irrigation', 'skip-to-result', 'result', 'schedule', 'next-steps'].includes(String(v.step)) && ['ready', 'missing'].includes(String(v.status));
  return Object.keys(v).length === 3 && (v.type === 'notice' || v.type === 'startup-error') &&
    typeof v.message === 'string' && v.message.length <= 600;
}

function isIanaTimeZone(value: string): boolean {
  try {new Intl.DateTimeFormat('en', {timeZone: value}); return true;} catch {return false;}
}
