import { SERIES_PALETTE } from '../analysis/seriesColors';
import type { Device } from '../types/farming';
import { isSensorObservationFresh } from './zoneSoil';

/**
 * Volumetric water content (VWC) display rules. The contract is
 * docs/contracts/vwc-display/vectors.json; osi-server keeps a byte copy and a
 * cloud twin of this file. Display only: nothing here feeds the scheduler.
 */

export const VWC_PCT_RANGE: readonly [number, number] = [0, 100];

export const VWC_SERIES_COLORS = {
  vwc: SERIES_PALETTE[0],
  soil_vic: SERIES_PALETTE[3],
} as const;

/** `absent` = no reading; `invalid` = something was reported but it is not a VWC percentage. */
export type VwcReadingState = 'value' | 'absent' | 'invalid';
export type VwcQualification = 'field_verified' | 'provisional' | 'generic';
export type VwcDerivation = 'probe_reported' | 'sentek_default_curve';

export type VwcDeviceLike = Partial<Pick<Device,
  | 'deveui'
  | 'type_id'
  | 'sdi12_probe_profile'
  | 'last_seen'
  | 'latest_data'
  | 'soil_moisture_probe_depths_json'
  | 'soilMoistureProbeDepths'
  | 'sdi12_channel_layout_json'>>;

export interface ZoneVwcSummary {
  /** At least one volumetric SDI-12 probe is configured in the zone. */
  hasSensor: boolean;
  /** Mean of the readings at the chosen depth (or channel); never a mean across depths. */
  value: number | null;
  depthCm: number | null;
  /** Set only when the chosen readings have no recorded depth. */
  channel: number | null;
  contributorCount: number;
  observedAt: string | null;
  stale: boolean;
  /** No usable reading, and at least one channel reported something out of range. */
  invalid: boolean;
  qualification: VwcQualification | null;
}

const VWC_CHANNEL_COUNT = 10;
const VWC_KEY = /^(?:vwc|soil_vic)_(\d+)$/;

export function vwcReadingState(value: unknown): VwcReadingState {
  if (value === null || value === undefined) return 'absent';
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'invalid';
  return value >= VWC_PCT_RANGE[0] && value <= VWC_PCT_RANGE[1] ? 'value' : 'invalid';
}

export function formatVwcPercent(value: unknown): string | null {
  return vwcReadingState(value) === 'value' ? `${(value as number).toFixed(1)} %` : null;
}

const QUALIFICATION_BY_PROFILE: Record<string, VwcQualification | null> = {
  SENTEK_ENVIROSCAN: 'field_verified',
  GENERIC_VWC: 'generic',
  TENSIOMARK: null,
};

/** Only the Sentek path is field-verified; an unknown profile is provisional until someone verifies it. */
export function vwcProfileQualification(profileId: string | null | undefined): VwcQualification | null {
  if (!profileId) return null;
  return profileId in QUALIFICATION_BY_PROFILE ? QUALIFICATION_BY_PROFILE[profileId] : 'provisional';
}

/** TriSCAN rows are converted from scaled frequency with the Sentek default curve by osi-sdi12-normalize. */
export function vwcDerivation(sensorType: string | null | undefined): VwcDerivation {
  return sensorType === 'TRISCAN' ? 'sentek_default_curve' : 'probe_reported';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveDepth(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function vwcChannelDepthCm(device: VwcDeviceLike, channelKey: string): number | null {
  const depths = asRecord(device.soil_moisture_probe_depths_json ?? device.soilMoistureProbeDepths);
  const mapped = positiveDepth(depths?.[channelKey]);
  if (mapped !== null) return mapped;

  if (device.type_id !== 'DRAGINO_SDI12') return null;
  const match = VWC_KEY.exec(channelKey);
  const layout = asRecord(device.sdi12_channel_layout_json);
  if (!match || !layout || layout.kind !== undefined || !Array.isArray(layout.sensors)) return null;
  const channel = Number(match[1]);
  const sensor = layout.sensors.find((entry) => asRecord(entry)?.channel === channel);
  return positiveDepth(asRecord(sensor)?.depth_cm);
}

interface VwcEntry {
  value: number;
  channel: number;
  depthCm: number | null;
  observedAt: string;
  qualification: VwcQualification | null;
}

const QUALIFICATION_RANK: Record<VwcQualification, number> = {
  provisional: 0,
  generic: 1,
  field_verified: 2,
};

function weakest(qualifications: Array<VwcQualification | null>): VwcQualification | null {
  let result: VwcQualification | null = null;
  for (const qualification of qualifications) {
    if (qualification === null) continue;
    if (result === null || QUALIFICATION_RANK[qualification] < QUALIFICATION_RANK[result]) result = qualification;
  }
  return result;
}

function newer(left: string | null, right: string | null | undefined): string | null {
  if (!right) return left;
  if (!left) return right;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function isVolumetricProbe(device: VwcDeviceLike): boolean {
  return device.type_id === 'DRAGINO_SDI12' && device.sdi12_probe_profile !== 'TENSIOMARK';
}

/**
 * The zone's "Soil now" VWC: the shallowest recorded depth, averaged only
 * across probes at that same depth. Fresh readings beat stale ones.
 */
export function summarizeZoneVwc(devices: VwcDeviceLike[], nowMs: number): ZoneVwcSummary {
  const eligible = devices.filter(isVolumetricProbe);
  if (eligible.length === 0) {
    return {
      hasSensor: false, value: null, depthCm: null, channel: null, contributorCount: 0,
      observedAt: null, stale: false, invalid: false, qualification: null,
    };
  }

  const entries: VwcEntry[] = [];
  let sawInvalid = false;
  let reportedAt: string | null = null;
  for (const device of eligible) {
    const data = asRecord(device.latest_data);
    const qualification = vwcProfileQualification(device.sdi12_probe_profile);
    for (let channel = 1; channel <= VWC_CHANNEL_COUNT; channel += 1) {
      const raw = data?.[`vwc_${channel}`];
      const state = vwcReadingState(raw);
      if (state === 'absent') continue;
      reportedAt = newer(reportedAt, device.last_seen);
      if (state === 'invalid') {
        sawInvalid = true;
        continue;
      }
      if (!device.last_seen || !Number.isFinite(Date.parse(device.last_seen))) continue;
      entries.push({
        value: raw as number,
        channel,
        depthCm: vwcChannelDepthCm(device, `vwc_${channel}`),
        observedAt: device.last_seen,
        qualification,
      });
    }
  }

  const fresh = entries.filter((entry) => isSensorObservationFresh(entry.observedAt, nowMs));
  const candidates = fresh.length > 0 ? fresh : entries;

  if (candidates.length === 0) {
    return {
      hasSensor: true, value: null, depthCm: null, channel: null, contributorCount: 0,
      observedAt: reportedAt,
      stale: !isSensorObservationFresh(reportedAt, nowMs),
      invalid: sawInvalid,
      qualification: weakest(eligible.map((device) => vwcProfileQualification(device.sdi12_probe_profile))),
    };
  }

  // Depth groups sort before channel groups; shallow before deep; low channel before high.
  const leader = candidates.slice().sort((left, right) => {
    if ((left.depthCm === null) !== (right.depthCm === null)) return left.depthCm === null ? 1 : -1;
    if (left.depthCm !== null && right.depthCm !== null) return left.depthCm - right.depthCm;
    return left.channel - right.channel;
  })[0];
  const group = candidates.filter((entry) => (leader.depthCm !== null
    ? entry.depthCm === leader.depthCm
    : entry.depthCm === null && entry.channel === leader.channel));

  return {
    hasSensor: true,
    value: group.reduce((sum, entry) => sum + entry.value, 0) / group.length,
    depthCm: leader.depthCm,
    channel: leader.depthCm === null ? leader.channel : null,
    contributorCount: group.length,
    observedAt: group.reduce<string | null>((latest, entry) => newer(latest, entry.observedAt), null),
    stale: fresh.length === 0,
    invalid: false,
    qualification: weakest(group.map((entry) => entry.qualification)),
  };
}
