import { allowedChoices } from './catalogModel';
import { deriveFieldStates } from './templateEngine';
import type {
  CaptureEntryValueInput,
  JournalCaptureCatalogModel,
  JournalLayoutDefinition,
  JournalSelections,
  JournalTemplateDefinition,
} from '../types/journalCapture';

export type LayoutTransitionReason = 'choice_invalid' | 'field_hidden';

export interface LayoutTransitionAffectedItem {
  readonly attribute_code: string;
  readonly group_index: number;
  readonly reason: LayoutTransitionReason;
  readonly value: Readonly<CaptureEntryValueInput>;
}

export type LayoutTransitionResolutionKind = 'kept' | 'replaced' | 'removed';

export interface ComputeLayoutTransitionDiffInput {
  model: JournalCaptureCatalogModel;
  oldLayout: JournalLayoutDefinition | undefined;
  newLayout: JournalLayoutDefinition | undefined;
  template: JournalTemplateDefinition | undefined;
  selections: JournalSelections;
  currentValues: readonly CaptureEntryValueInput[];
}

function hasEnteredValue(value: CaptureEntryValueInput): boolean {
  if (value.value_status != null && value.value_status !== 'observed') return true;
  return value.value !== undefined && value.value !== null && value.value !== ''
    || value.value_text !== undefined && value.value_text !== null && value.value_text !== ''
    || value.entered_value_num !== undefined && value.entered_value_num !== null
    || value.value_num !== undefined && value.value_num !== null;
}

function visibleCodes(
  template: JournalTemplateDefinition,
  layout: JournalLayoutDefinition,
  selections: JournalSelections,
): Set<string> {
  return new Set(
    deriveFieldStates(template, layout, selections)
      .filter((state) => state.visible)
      .map((state) => state.code),
  );
}

/**
 * Pure diff over (oldLayoutDefinition, newLayoutDefinition, currentValues) that finds
 * user-entered values a layout/plot switch would otherwise silently invalidate: a
 * previously visible field that the new layout no longer shows, or a chosen choice
 * value the new layout's option_dependencies no longer allow. Resolution (kept /
 * replaced / removed) is left to the caller — this module only detects, never mutates.
 */
export function computeLayoutTransitionDiff({
  model,
  oldLayout,
  newLayout,
  template,
  selections,
  currentValues,
}: ComputeLayoutTransitionDiffInput): LayoutTransitionAffectedItem[] {
  if (!oldLayout || !newLayout || !template) return [];

  const oldVisible = visibleCodes(template, oldLayout, selections);
  const newVisible = visibleCodes(template, newLayout, selections);

  const affected: LayoutTransitionAffectedItem[] = [];
  for (const value of currentValues) {
    if (!hasEnteredValue(value)) continue;
    const attribute = model.vocabByCode.get(value.attribute_code);
    if (!attribute || attribute.kind !== 'attribute') continue;
    const groupIndex = value.group_index ?? 0;

    if (!oldVisible.has(value.attribute_code)) continue; // not caused by this transition
    if (!newVisible.has(value.attribute_code)) {
      affected.push({
        attribute_code: value.attribute_code,
        group_index: groupIndex,
        reason: 'field_hidden',
        value,
      });
      continue;
    }

    if (attribute.value_type === 'choice') {
      const selected = value.value ?? value.value_text;
      if (typeof selected === 'string' && selected !== '') {
        const choices = allowedChoices(model, newLayout, value.attribute_code, selections);
        if (!choices.includes(selected)) {
          affected.push({
            attribute_code: value.attribute_code,
            group_index: groupIndex,
            reason: 'choice_invalid',
            value,
          });
        }
      }
    }
  }
  return affected;
}

export function layoutTransitionItemKey(attributeCode: string, groupIndex: number): string {
  return `${attributeCode}:${groupIndex}`;
}
