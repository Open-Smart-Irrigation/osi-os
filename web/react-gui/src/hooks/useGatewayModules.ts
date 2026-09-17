import useSWR from 'swr';

import { systemSettingsAPI, type SystemSettings } from '../services/api';

/**
 * SWR key for the gateway-level settings document. SettingsPage uses the same
 * key, so a switch flipped there updates every consumer of these hooks without
 * a refetch.
 */
export const GATEWAY_SETTINGS_KEY = '/api/system/settings';

export interface GatewayModuleFlags {
  /** Data view entry points: the Data header link and the Data tab. */
  data: boolean;
  /** Network view entry point. */
  network: boolean;
  /** The gateway hub card on the dashboard ("Gateway" / "Passerelle"). */
  gatewayHub: boolean;
  /** Field Journal entry points -- and the journal-v2 replication worker. */
  journal: boolean;
}

/**
 * Defaults while the settings document is loading or unreachable.
 *
 * Everything visible: main ships all four modules on, so assuming "off" would
 * make the entry points flicker away on every page load for every install that
 * has them on -- and an unreachable gateway is not evidence that a module was
 * switched off. This mirrors the backend's own fail-open read.
 */
const DEFAULT_FLAGS: GatewayModuleFlags = {
  data: true,
  network: true,
  gatewayHub: true,
  journal: true,
};

export function useGatewaySettings() {
  return useSWR<SystemSettings>(GATEWAY_SETTINGS_KEY, () => systemSettingsAPI.get(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

/**
 * Which visibility modules are switched on for this gateway.
 *
 * These are gateway settings, not per-browser preferences (owner decision,
 * 2026-09-17): every user of a gateway sees the same surface, and the choice
 * survives a browser change. The Field Journal one has to work this way
 * regardless -- switching it off also stops the journal-v2 replication worker
 * contacting the cloud, which no browser-local value could ever do.
 *
 * A gateway that predates a given setting reports it absent, which means on.
 */
export function useGatewayModules(): GatewayModuleFlags {
  const { data } = useGatewaySettings();
  if (!data) return DEFAULT_FLAGS;
  return {
    data: data.dataModuleEnabled ?? DEFAULT_FLAGS.data,
    network: data.networkModuleEnabled ?? DEFAULT_FLAGS.network,
    gatewayHub: data.gatewayHubModuleEnabled ?? DEFAULT_FLAGS.gatewayHub,
    journal: data.journalModuleEnabled ?? DEFAULT_FLAGS.journal,
  };
}
