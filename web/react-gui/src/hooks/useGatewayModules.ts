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
 * What the browser shows when the gateway could not be asked at all.
 *
 * Not a copy of the defaults: the defaults live on the gateway (osi-module-
 * defaults, reported as `moduleDefaults`) because a branch may ship a module
 * hidden. This is the failure answer only. An unreachable gateway is not
 * evidence that a module was switched off, and a dashboard with no route back
 * to Data or Journal is worse than one showing an entry point that turns out to
 * be hidden -- so a failed request shows everything, and only after it has
 * actually failed.
 */
const VISIBLE_ON_FAILURE: GatewayModuleFlags = {
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
 * Which visibility modules are switched on for this gateway, or `null` while
 * that is still unknown.
 *
 * These are gateway settings, not per-browser preferences (owner decision,
 * 2026-09-17): every user of a gateway sees the same surface, and the choice
 * survives a browser change. The Field Journal one has to work this way
 * regardless -- switching it off also stops the journal-v2 replication worker
 * contacting the cloud, which no browser-local value could ever do.
 *
 * `null` means "not answered yet", and consumers render the gated entries only
 * once they have an answer. The browser cannot guess: a gateway shipping a
 * module hidden and one shipping it visible look identical until the response
 * arrives, so any guess flashes the wrong surface on one of them.
 *
 * Resolution order, once the response is in:
 *  1. the stored value for that module, if the switch has ever been written;
 *  2. otherwise the default the gateway declared for itself in `moduleDefaults`;
 *  3. otherwise visible -- a gateway older than this contract has no hidden
 *     modules to report.
 *
 * SWR keeps the last successful response, so a later poll that fails leaves the
 * surface on the values that gateway last reported rather than resetting it.
 */
export function useGatewayModules(): GatewayModuleFlags | null {
  const { data, error } = useGatewaySettings();
  if (data) {
    const defaults = data.moduleDefaults;
    return {
      data: data.dataModuleEnabled ?? defaults?.dataModuleEnabled ?? true,
      network: data.networkModuleEnabled ?? defaults?.networkModuleEnabled ?? true,
      gatewayHub: data.gatewayHubModuleEnabled ?? defaults?.gatewayHubModuleEnabled ?? true,
      journal: data.journalModuleEnabled ?? defaults?.journalModuleEnabled ?? true,
    };
  }
  if (error) return VISIBLE_ON_FAILURE;
  return null;
}
