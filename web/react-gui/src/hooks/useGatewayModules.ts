import useSWR from 'swr';

import { systemSettingsAPI, type SystemSettings } from '../services/api';

/**
 * SWR key for the gateway-level settings document. SettingsPage uses the same
 * key, so a switch flipped there updates every consumer of these hooks without
 * a refetch.
 */
export const GATEWAY_SETTINGS_KEY = '/api/system/settings';

export function useGatewaySettings() {
  return useSWR<SystemSettings>(GATEWAY_SETTINGS_KEY, () => systemSettingsAPI.get(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

/**
 * Whether the Field Journal module is switched on for this gateway.
 *
 * Unlike the display-only module toggles in `displayPreferences.ts`, this one is
 * a gateway-level setting: switching it off also stops the journal-v2
 * replication worker from contacting the cloud, which a per-browser preference
 * cannot do.
 *
 * Defaults to visible while the setting is loading or unreachable. Main ships
 * the module on, so assuming "off" would make the Journal entry points flicker
 * away on every page load for every install that has it on -- and an
 * unreachable gateway is not evidence that the module was switched off.
 */
export function useJournalModuleEnabled(): boolean {
  const { data } = useGatewaySettings();
  return data?.journalModuleEnabled ?? true;
}
