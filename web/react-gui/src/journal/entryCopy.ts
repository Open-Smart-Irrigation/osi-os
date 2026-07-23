// Aggregate -> CreateEntryPayload adapter for desktop full-record "copy this
// entry" (session wrap-up plan, 2026-07-23, docs/superpowers/plans/
// 2026-07-23-journal-copy-entry-and-polish-plan.md §A). Unlike
// entryCorrection.ts's buildCorrectionPayload (which PUTs against the
// source's own entry_uuid + base_sync_version), this ALWAYS builds a brand
// new create: a fresh client uuid, base_sync_version 0, no path segment
// naming the source at all. That is the load-bearing safety property (A6) —
// this module must never accept or emit anything that could route a save
// back onto the source entry.
import { randomUuid } from '../utils/uuid';
import type { CreateEntryPayload } from '../services/journalApi';
import type { EntryAggregate, EntryValueInput } from '../types/journal';
import type { CaptureEntryValueOutput } from '../types/journalCapture';
import { currentCropInfoForPlot } from './cropCycle';
import { mergedValues } from './entryCorrection';
import type { ActiveCropCycle } from '../types/journal';

// NIT 9 (mirrors DetailPanel's/JournalCaptureFlow's own omission): an
// internal valve-expectation linkage id scoped to the SOURCE entry's own
// actuation attempt. Carrying it onto a brand-new entry would falsely link
// the copy to a valve command it was never actually part of (A3).
const OMITTED_COPY_VALUE_CODE = 'attr.actuation_expectation_id';

export interface CopySeason {
  season_crop: string | null;
  season_variety: string | null;
}

// A5: "season_crop/season_variety: re-derive from the plot's active_crop_cycles
// as of the copy's occurred date... fall back to null. NEVER carry the
// source's stored value, and never the display-only closed_crop_code/
// closed_crop_variety." Mirrors JournalCaptureFlow.tsx's inferredCrop gate
// (occurredLocalDate >= the covering open cycle's seeded date) via the same
// authoritative currentCropInfoForPlot read cropCycle.ts already exposes —
// zero, or more than one, open cycle both resolve to null here exactly like
// that gate does (an intercropped/cycle-less plot is deferred, never
// guessed).
export function deriveCopySeason(
  activeCropCycles: readonly ActiveCropCycle[] | null | undefined,
  occurredLocalDate: string,
): CopySeason {
  const info = currentCropInfoForPlot(activeCropCycles);
  if (!info || occurredLocalDate < info.seededDate) {
    return { season_crop: null, season_variety: null };
  }
  return { season_crop: info.crop_code, season_variety: info.variety };
}

// The pieces of a copy's payload that cannot be derived from the source
// aggregate alone: the NEW occurred date/time (resolved in the source's own
// timezone, DST-safe — see journal/occurrence.ts's resolveOccurrence), the
// target plot's CURRENT zone assignment and re-derived season, the CURRENT
// catalog template/layout versions the copy is actually being captured
// against, and the edited note textarea value. The host (DetailPanel's
// EntryCopyForm) resolves every one of these from data already in its own
// scope (the `plots` prop, the `model`-resolved `template`/`layout`, its own
// date input and note field) and passes them in here as one bag, so this
// module itself never needs a plots list or a catalog model.
export interface CopyOccurrenceInput {
  occurred_start_local: string;
  occurred_timezone: string;
  occurred_utc_offset_minutes: number;
  zone_uuid: string | null;
  season_crop: string | null;
  season_variety: string | null;
  template_code: string;
  template_version: number;
  layout_code: string;
  layout_version: number;
  note: string | null;
}

export function buildCopyPayload(
  aggregate: EntryAggregate,
  formOwnedAttributeCodes: ReadonlySet<string>,
  editedValues: readonly CaptureEntryValueOutput[],
  occurrence: CopyOccurrenceInput,
  // A fresh client-generated uuid for the NEW entry. The caller passes a value
  // held stable across a duplicate-guard-409 ack-retry (like the capture flow's
  // draft.entryUuid) so a double "save separately" re-POSTs the SAME uuid — the
  // second lands as a 409, not a second create. Defaults to a fresh uuid when
  // omitted; never the source's entry_uuid either way.
  entryUuid: string = randomUuid(),
): CreateEntryPayload {
  const values: EntryValueInput[] = mergedValues(aggregate.values, formOwnedAttributeCodes, editedValues)
    .filter((value) => value.attribute_code !== OMITTED_COPY_VALUE_CODE);

  return {
    entry_uuid: entryUuid,
    base_sync_version: 0,
    status: 'final',
    plot_uuid: aggregate.plot_uuid,
    zone_uuid: occurrence.zone_uuid,
    season_crop: occurrence.season_crop,
    season_variety: occurrence.season_variety,
    campaign_uuid: aggregate.campaign_uuid,
    protocol_code: aggregate.protocol_code,
    protocol_version: aggregate.protocol_version,
    observation_unit_code: aggregate.observation_unit_code,
    activity_code: aggregate.activity_code,
    template_code: occurrence.template_code,
    template_version: occurrence.template_version,
    layout_code: occurrence.layout_code,
    layout_version: occurrence.layout_version,
    occurred_start_local: occurrence.occurred_start_local,
    occurred_end_local: null,
    occurred_timezone: occurrence.occurred_timezone,
    occurred_utc_offset_minutes: occurrence.occurred_utc_offset_minutes,
    occurred_end_utc_offset_minutes: null,
    note: occurrence.note,
    values,
    // Deliberately OMITTED (never set, not even to null/undefined-explicit):
    // device_eui (a live-capture-only field JournalCaptureFlow's own create
    // payload never sets either), pass_uuid, batch_uuid, cycle_action,
    // cycle_uuid, ends_crop_cycle, duplicate_guard_ack_entry_uuid (added by
    // the host only on an explicit save-separately retry), and context_json
    // (the edge always freezes a fresh sensor snapshot on create).
  };
}
