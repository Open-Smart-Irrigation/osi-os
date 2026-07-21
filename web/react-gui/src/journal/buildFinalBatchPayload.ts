import type {
  CreateFinalBatchPayload,
  EntryValueInput,
  JournalBatchMember,
  JournalEntryWriteFields,
} from '../types/journal';

export interface BuildFinalBatchInput
  extends Omit<JournalEntryWriteFields, 'status' | 'plot_uuid' | 'zone_uuid' | 'values'> {
  members: readonly JournalBatchMember[];
  values: readonly EntryValueInput[];
  duplicate_guard_ack_entry_uuids?: readonly string[];
}

export interface BatchDomainError {
  error: 'invalid_batch' | 'batch_too_large' | 'duplicate_plot' | 'duplicate_entry_uuid';
  message: string;
  details: null;
}

export type BuildFinalBatchResult =
  | { ok: true; payload: CreateFinalBatchPayload }
  | { ok: false; error: BatchDomainError };

function failure(error: BatchDomainError): BuildFinalBatchResult {
  return { ok: false, error };
}

export function buildFinalBatchPayload(input: BuildFinalBatchInput): BuildFinalBatchResult {
  const members = input.members.map((member) => ({ ...member }));
  if (members.length === 0) {
    return failure({
      error: 'invalid_batch',
      message: 'Batch plots must be a nonempty array',
      details: null,
    });
  }
  if (members.length > 100) {
    return failure({
      error: 'batch_too_large',
      message: 'A journal batch may contain at most 100 plots',
      details: null,
    });
  }
  if (new Set(members.map(({ plot_uuid }) => plot_uuid)).size !== members.length) {
    return failure({
      error: 'duplicate_plot',
      message: 'A journal batch cannot contain duplicate plots',
      details: null,
    });
  }
  if (new Set(members.map(({ entry_uuid }) => entry_uuid)).size !== members.length) {
    return failure({
      error: 'duplicate_entry_uuid',
      message: 'A journal batch cannot contain duplicate member entry UUIDs',
      details: null,
    });
  }

  const acknowledgements = input.duplicate_guard_ack_entry_uuids;
  const payload: CreateFinalBatchPayload = {
    status: 'final',
    members: members.sort((left, right) => left.plot_uuid.localeCompare(right.plot_uuid)),
    base_sync_version: 0,
    ...(input.device_eui !== undefined ? { device_eui: input.device_eui } : {}),
    ...(input.season_crop !== undefined ? { season_crop: input.season_crop } : {}),
    ...(input.season_variety !== undefined ? { season_variety: input.season_variety } : {}),
    ...(input.campaign_uuid !== undefined ? { campaign_uuid: input.campaign_uuid } : {}),
    ...(input.protocol_code !== undefined ? { protocol_code: input.protocol_code } : {}),
    ...(input.protocol_version !== undefined ? { protocol_version: input.protocol_version } : {}),
    ...(input.observation_unit_code !== undefined
      ? { observation_unit_code: input.observation_unit_code }
      : {}),
    ...(input.pass_uuid !== undefined ? { pass_uuid: input.pass_uuid } : {}),
    activity_code: input.activity_code,
    template_code: input.template_code,
    template_version: input.template_version,
    layout_code: input.layout_code,
    layout_version: input.layout_version,
    occurred_start_local: input.occurred_start_local,
    ...(input.occurred_end_local !== undefined
      ? { occurred_end_local: input.occurred_end_local }
      : {}),
    occurred_timezone: input.occurred_timezone,
    ...(input.occurred_utc_offset_minutes !== undefined
      ? { occurred_utc_offset_minutes: input.occurred_utc_offset_minutes }
      : {}),
    ...(input.occurred_end_utc_offset_minutes !== undefined
      ? { occurred_end_utc_offset_minutes: input.occurred_end_utc_offset_minutes }
      : {}),
    values: [...input.values],
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.cycle_action !== undefined ? { cycle_action: input.cycle_action } : {}),
    ...(input.cycle_uuid !== undefined ? { cycle_uuid: input.cycle_uuid } : {}),
    ...(input.ends_crop_cycle !== undefined ? { ends_crop_cycle: input.ends_crop_cycle } : {}),
  };
  if (acknowledgements && acknowledgements.length > 0) {
    payload.duplicate_guard_ack_entry_uuids = [...acknowledgements];
  }
  return { ok: true, payload };
}

export interface TankMixPassBatchMember {
  entry_uuid: string;
  values: readonly EntryValueInput[];
}

export interface BuildTankMixPassBatchInput
  extends Omit<JournalEntryWriteFields, 'status' | 'plot_uuid' | 'zone_uuid' | 'values'> {
  plot_uuid: string;
  pass_uuid: string;
  primary_entry_uuid: string;
  primary_values: readonly EntryValueInput[];
  // Only the ADDITIONAL queued members ("Add product to this pass") — the
  // primary/currently-edited product is `primary_entry_uuid`/`primary_values`
  // above, and is always member 0 of the resulting batch.
  members: readonly TankMixPassBatchMember[];
  duplicate_guard_ack_entry_uuids?: readonly string[];
}

// Slice F (B1/B2 fix, atomic tank-mix pass): builds ONE CreateFinalBatchPayload
// covering the WHOLE pass — the primary/currently-edited product AND every
// queued "Add product to this pass" member — as a single-plot batch sharing
// one pass_uuid, committed by the edge in ONE transaction
// (osi-journal/lifecycle.js finalizeBatch, generalized to accept a same-plot
// pass alongside its original cross-plot-batch case; every member here
// shares `plot_uuid`, unlike buildFinalBatchPayload's cross-plot siblings
// above, which require distinct plots).
//
// This replaces the old buildTankMixPassPayloads, which built N separate
// journalApi.createEntry payloads chained by duplicate_guard_ack_entry_uuid:
// a mid-loop failure left earlier members permanently persisted with no
// retry path that re-ran the loop (B1), and the chain's assumption that the
// edge's findDuplicateCandidate would resolve to "the immediately preceding
// entry" broke down because that query's tie-break is lowest entry_uuid, not
// insertion order — a 3+ product pass failed close to half the time,
// depending on how the member UUIDs happened to sort (B2). The edge now
// excludes same-pass_uuid candidates from the duplicate guard entirely, so
// no per-member acknowledgement is built here at all.
export function buildTankMixPassBatchPayload(
  input: BuildTankMixPassBatchInput,
): BuildFinalBatchResult {
  if (!input.plot_uuid) {
    return failure({
      error: 'invalid_batch',
      message: 'A tank-mix pass requires a resolved plot',
      details: null,
    });
  }
  const memberEntryUuids = [input.primary_entry_uuid, ...input.members.map((member) => member.entry_uuid)];
  if (new Set(memberEntryUuids).size !== memberEntryUuids.length) {
    return failure({
      error: 'duplicate_entry_uuid',
      message: 'A tank-mix pass cannot contain duplicate member entry UUIDs',
      details: null,
    });
  }
  if (memberEntryUuids.length > 100) {
    return failure({
      error: 'batch_too_large',
      message: 'A tank-mix pass may contain at most 100 products',
      details: null,
    });
  }

  const members: JournalBatchMember[] = [
    { plot_uuid: input.plot_uuid, entry_uuid: input.primary_entry_uuid, values: [...input.primary_values] },
    ...input.members.map((member) => ({
      plot_uuid: input.plot_uuid,
      entry_uuid: member.entry_uuid,
      values: [...member.values],
    })),
  ];
  const acknowledgements = input.duplicate_guard_ack_entry_uuids;
  const payload: CreateFinalBatchPayload = {
    status: 'final',
    members,
    base_sync_version: 0,
    pass_uuid: input.pass_uuid,
    ...(input.device_eui !== undefined ? { device_eui: input.device_eui } : {}),
    ...(input.season_crop !== undefined ? { season_crop: input.season_crop } : {}),
    ...(input.season_variety !== undefined ? { season_variety: input.season_variety } : {}),
    ...(input.campaign_uuid !== undefined ? { campaign_uuid: input.campaign_uuid } : {}),
    ...(input.protocol_code !== undefined ? { protocol_code: input.protocol_code } : {}),
    ...(input.protocol_version !== undefined ? { protocol_version: input.protocol_version } : {}),
    ...(input.observation_unit_code !== undefined
      ? { observation_unit_code: input.observation_unit_code }
      : {}),
    activity_code: input.activity_code,
    template_code: input.template_code,
    template_version: input.template_version,
    layout_code: input.layout_code,
    layout_version: input.layout_version,
    occurred_start_local: input.occurred_start_local,
    ...(input.occurred_end_local !== undefined
      ? { occurred_end_local: input.occurred_end_local }
      : {}),
    occurred_timezone: input.occurred_timezone,
    ...(input.occurred_utc_offset_minutes !== undefined
      ? { occurred_utc_offset_minutes: input.occurred_utc_offset_minutes }
      : {}),
    ...(input.occurred_end_utc_offset_minutes !== undefined
      ? { occurred_end_utc_offset_minutes: input.occurred_end_utc_offset_minutes }
      : {}),
    // Unused by the edge here: every member above supplies its own values.
    // Present only because CreateFinalBatchPayload's shape requires it,
    // matching buildFinalBatchPayload's cross-plot sibling above.
    values: [],
    ...(input.note !== undefined ? { note: input.note } : {}),
    // The crop-cycle cascade (open/close) is one agronomic decision for the
    // whole pass, not one per product line — the edge only ever applies
    // cycle_action/cycle_uuid/ends_crop_cycle to the pass's first/primary
    // member (finalizeBatch), so sending them once here at the batch's top
    // level is enough.
    ...(input.cycle_action !== undefined ? { cycle_action: input.cycle_action } : {}),
    ...(input.cycle_uuid !== undefined ? { cycle_uuid: input.cycle_uuid } : {}),
    ...(input.ends_crop_cycle !== undefined ? { ends_crop_cycle: input.ends_crop_cycle } : {}),
  };
  if (acknowledgements && acknowledgements.length > 0) {
    payload.duplicate_guard_ack_entry_uuids = [...acknowledgements];
  }
  return { ok: true, payload };
}
