export type JournalDetailPreference = 'farmer_quick' | 'full_record';

const TEMPLATE_ORDER = ['farmer_quick', 'full_record', 'research_observation'] as const;

export function normalizeJournalDetailPreference(value: string | null | undefined): JournalDetailPreference {
  if (value === 'research_observation') return 'full_record';
  return value === 'full_record' ? 'full_record' : 'farmer_quick';
}

export function resolveTemplateCode(
  supportedTemplates: readonly string[],
  preference: string | null | undefined,
): string {
  const normalized = normalizeJournalDetailPreference(preference);
  if (supportedTemplates.includes(normalized)) return normalized;
  return [...supportedTemplates]
    .sort((left, right) => TEMPLATE_ORDER.indexOf(left as typeof TEMPLATE_ORDER[number]) - TEMPLATE_ORDER.indexOf(right as typeof TEMPLATE_ORDER[number]) || left.localeCompare(right))[0] ?? '';
}
