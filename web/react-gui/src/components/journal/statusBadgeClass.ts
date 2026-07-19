import type { EntryStatus } from '../../types/journal';

// The single source of truth for the entry status badge's Tailwind classes.
// JournalEntryRow (mobile timeline) and EntryTable (desktop) both render the
// same status badge and must not be able to drift from each other.
const STATUS_BADGE_CLASS: Record<EntryStatus, string> = {
  final: 'bg-[var(--success-bg)] text-[var(--success-text)]',
  draft: 'bg-[var(--warn-bg)] text-[var(--warn-text)]',
  voided: 'bg-red-100 text-red-800',
};

export function statusBadgeClass(status: EntryStatus): string {
  return STATUS_BADGE_CLASS[status];
}
