// Aggregate -> UpdateEntryPayload adapter for desktop full-record correction
// (Slice 2 Task 30). The edge's correction path (osi-journal/lifecycle.js
// correctFinalInTransaction -> replaceExistingWithFinal) fully overwrites the
// journal_entries row (every CORRECTION_COLUMN) and DELETE+re-INSERTs every
// journal_entry_values row from whatever this payload sends. There is no
// partial-field PATCH on the wire. So this adapter must carry every
// untouched identity/context/occurrence field, and every value the
// correction form does not own, forward unchanged — dropping any of them
// here would silently erase it on the gateway.
import type { UpdateEntryPayload } from '../services/journalApi';
import type { EntryAggregate, EntryValue, EntryValueInput } from '../types/journal';
import type { CaptureEntryValueInput, CaptureEntryValueOutput, JournalScalar } from '../types/journalCapture';

export interface JournalContextSnapshot {
  channels?: Record<string, unknown>;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Safely reads the sensor-context snapshot frozen at entry time
// (osi-journal/context.js buildContext). The wire shape is a JSON blob, not
// a typed contract this GUI owns — parse it defensively rather than coupling
// the correction/read-back view to its exact channel schema.
export function parseContextSnapshot(contextJson: string | null): JournalContextSnapshot | null {
  if (!contextJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contextJson);
  } catch {
    return null;
  }
  return isRecord(parsed) ? (parsed as JournalContextSnapshot) : null;
}

// Converts a UTC instant plus a fixed offset (minutes east of UTC) into the
// naive local wall-clock string the edge PUT /entries/:uuid contract expects
// (osi-journal/lifecycle.js resolveLocalTime / LOCAL_TIMESTAMP). Sending the
// SAME offset back in occurred_utc_offset_minutes makes the edge reconstruct
// the identical instant even across a DST transition.
function localTimeFromInstant(instant: string, offsetMinutes: number): string {
  const shifted = new Date(Date.parse(instant) + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 16);
}

// Shared by both non-live-capture EntryForm hosts (DetailPanel's correction
// form, DraftsQueue's DraftResumePanel) to derive a `JournalSelections`-
// compatible scalar map from a set of stored/carried values -- the same
// shape JournalCaptureFlow's live `selections` state already carries, so
// deriveFieldStates resolves identically regardless of which host called it.
export function scalarSelectionsFromValues(
  values: readonly CaptureEntryValueInput[],
): Record<string, JournalScalar> {
  const result: Record<string, JournalScalar> = {};
  for (const value of values) {
    const scalar = value.value ?? value.value_text ?? value.entered_value_num ?? value.value_num;
    if (typeof scalar === 'string' || typeof scalar === 'number' || typeof scalar === 'boolean') {
      result[value.attribute_code] = scalar;
    }
  }
  return result;
}

// v10 comment-everywhere decision (spec §0.4): the comment textarea EntryForm
// renders for the top-level `note` field state stores its text into `values`
// under attribute_code 'note' (safe: 'note' is not an attribute, so it is
// filtered out of visibleInputs before buildEntryValues ever sees it — see
// EntryForm.tsx's visibleAttributeStates). `note` never reaches
// payloadValues/formPayload (both attribute-value-only), so it must be read
// back out of the raw `values` state instead and threaded onto the
// top-level `note` field every write payload carries
// (JournalEntryWriteFields.note). Shared by all three EntryForm hosts
// (JournalCaptureFlow, DetailPanel's correction form, DraftsQueue's
// DraftResumePanel) so a stored/typed note round-trips identically
// regardless of which host is reading it back.
export function currentNoteValue(values: readonly CaptureEntryValueInput[]): string | undefined {
  const input = values.find(({ attribute_code }) => attribute_code === 'note');
  if (!input) return undefined;
  const raw = typeof input.value === 'string'
    ? input.value
    : typeof input.value_text === 'string' ? input.value_text : undefined;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

// Merges the correction form's edited values over the aggregate's stored
// values. A value is "owned" by the form when its attribute_code is in
// `formOwnedAttributeCodes` (the current template/layout's addressable
// fields): every stored row for an owned code is replaced wholesale by
// whatever the form submits for that code (including zero rows, if the user
// removed a repeatable group entirely — matching how the shared EntryForm
// engine already re-specifies a field's full row set on every change). Every
// row whose code is NOT owned by the form (legacy/custom values, or values
// outside this template) passes through byte-for-byte unchanged.
function mergedValues(
  baseValues: readonly EntryValue[],
  formOwnedAttributeCodes: ReadonlySet<string>,
  editedValues: readonly CaptureEntryValueOutput[],
): EntryValueInput[] {
  const preserved = baseValues.filter((value) => !formOwnedAttributeCodes.has(value.attribute_code));
  return [...preserved, ...editedValues];
}

export function buildCorrectionPayload(
  aggregate: EntryAggregate,
  formOwnedAttributeCodes: ReadonlySet<string>,
  editedValues: readonly CaptureEntryValueOutput[],
): UpdateEntryPayload {
  const hasEnd = aggregate.occurred_end != null;
  return {
    entry_uuid: aggregate.entry_uuid,
    base_sync_version: aggregate.sync_version,
    status: 'final',
    plot_uuid: aggregate.plot_uuid,
    zone_uuid: aggregate.zone_uuid,
    device_eui: aggregate.device_eui,
    season_crop: aggregate.season_crop,
    season_variety: aggregate.season_variety,
    campaign_uuid: aggregate.campaign_uuid,
    protocol_code: aggregate.protocol_code,
    protocol_version: aggregate.protocol_version,
    observation_unit_code: aggregate.observation_unit_code,
    pass_uuid: aggregate.pass_uuid,
    batch_uuid: aggregate.batch_uuid,
    activity_code: aggregate.activity_code,
    template_code: aggregate.template_code,
    template_version: aggregate.template_version,
    layout_code: aggregate.layout_code,
    layout_version: aggregate.layout_version,
    occurred_start_local: localTimeFromInstant(aggregate.occurred_start, aggregate.occurred_utc_offset_minutes),
    occurred_end_local: hasEnd
      ? localTimeFromInstant(aggregate.occurred_end as string, aggregate.occurred_utc_offset_minutes)
      : null,
    occurred_timezone: aggregate.occurred_timezone,
    occurred_utc_offset_minutes: aggregate.occurred_utc_offset_minutes,
    occurred_end_utc_offset_minutes: hasEnd ? aggregate.occurred_utc_offset_minutes : null,
    note: aggregate.note,
    values: mergedValues(aggregate.values, formOwnedAttributeCodes, editedValues),
  };
}
