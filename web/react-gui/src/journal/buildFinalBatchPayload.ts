import type {
  CreateFinalBatchPayload,
  EntryValueInput,
  JournalEntryWriteFields,
} from '../types/journal';

export interface BuildFinalBatchInput
  extends Omit<JournalEntryWriteFields, 'status' | 'plot_uuid' | 'zone_uuid' | 'values'> {
  plotUuids: readonly string[];
  values: readonly EntryValueInput[];
  duplicate_guard_ack_entry_uuids?: readonly string[];
}

export interface BatchDomainError {
  error: 'invalid_batch' | 'batch_too_large' | 'duplicate_plot';
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
  const plotUuids = [...input.plotUuids];
  if (plotUuids.length === 0) {
    return failure({
      error: 'invalid_batch',
      message: 'Batch plots must be a nonempty array',
      details: null,
    });
  }
  if (plotUuids.length > 100) {
    return failure({
      error: 'batch_too_large',
      message: 'A journal batch may contain at most 100 plots',
      details: null,
    });
  }
  if (new Set(plotUuids).size !== plotUuids.length) {
    return failure({
      error: 'duplicate_plot',
      message: 'A journal batch cannot contain duplicate plots',
      details: null,
    });
  }

  const acknowledgements = input.duplicate_guard_ack_entry_uuids;
  const payload: CreateFinalBatchPayload = {
    status: 'final',
    plot_uuids: plotUuids.sort(),
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
  };
  if (acknowledgements && acknowledgements.length > 0) {
    payload.duplicate_guard_ack_entry_uuids = [...acknowledgements];
  }
  return { ok: true, payload };
}
