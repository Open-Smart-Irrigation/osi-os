import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  EntryAggregate,
  JournalCatalog,
  JournalDefinitionRow,
  JournalProductRow,
  JournalVocabRow,
} from '../../../types/journal';
import type { DraftsQueueStatus } from '../../../journal/useDraftsQueue';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key),
    i18n: { resolvedLanguage: 'en-GB', language: 'en-GB' },
  }),
}));

const { useDraftsQueueMock } = vi.hoisted(() => ({ useDraftsQueueMock: vi.fn() }));
vi.mock('../../../journal/useDraftsQueue', () => ({
  useDraftsQueue: useDraftsQueueMock,
}));

const { useJournalCatalogMock } = vi.hoisted(() => ({ useJournalCatalogMock: vi.fn() }));
vi.mock('../../../journal/useJournalCatalog', () => ({
  useJournalCatalog: useJournalCatalogMock,
}));

const { discardDraftMock, createEntryMock } = vi.hoisted(() => ({
  discardDraftMock: vi.fn(),
  createEntryMock: vi.fn(),
}));
vi.mock('../../../services/journalApi', () => ({
  journalApi: {
    discardDraft: (uuid: string) => discardDraftMock(uuid),
    createEntry: (payload: unknown) => createEntryMock(payload),
  },
}));

import { DraftsQueue } from '../DraftsQueue';

function draft(entryUuid: string, overrides: Partial<EntryAggregate> = {}): EntryAggregate {
  return {
    entry_uuid: entryUuid,
    activity_code: 'irrigation',
    plot_uuid: 'p1',
    status: 'draft',
    sync_version: 0,
    layout_code: 'open_field',
    layout_version: 1,
    template_code: 'full_record',
    template_version: 1,
    occurred_start: '2026-07-18T08:00:00.000Z',
    occurred_end: null,
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    values: [],
    ...overrides,
  } as unknown as EntryAggregate;
}

function queueState(overrides: {
  status: DraftsQueueStatus;
  drafts?: EntryAggregate[];
  error?: unknown;
  retry?: () => Promise<void>;
}) {
  return {
    drafts: overrides.drafts ?? [],
    status: overrides.status,
    error: overrides.error,
    retry: overrides.retry ?? vi.fn().mockResolvedValue(undefined),
  };
}

function vocabRow(code: string, overrides: Partial<JournalVocabRow> = {}): JournalVocabRow {
  return {
    code,
    kind: 'attribute',
    parent_code: null,
    value_type: 'text',
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: null,
    scope: 'core',
    owner_user_uuid: null,
    gateway_device_eui: null,
    custom_field_uuid: null,
    active: 1,
    sort_order: 0,
    sync_version: 0,
    created_at: '2026-07-18T00:00:00.000Z',
    deleted_at: null,
    catalog_errors: [],
    labels: { en: code },
    constraints: null,
    ...overrides,
  } as JournalVocabRow;
}

function definitionRow(code: string, definition: Record<string, unknown>): JournalDefinitionRow {
  return { code, version: 1, active: 1, catalog_errors: [], definition } as JournalDefinitionRow;
}

function resumeCatalog(): JournalCatalog {
  return {
    catalog_version: 1,
    catalog_hash: 'resume-catalog',
    vocab: [
      vocabRow('irrigation', { kind: 'activity', value_type: null }),
      vocabRow('attr.optional_note', { value_type: 'text' }),
      vocabRow('attr.required_note', { value_type: 'text' }),
    ],
    templates: [definitionRow('full_record', {
      fields: [
        'attr.optional_note',
        { code: 'attr.required_note', required: true },
      ],
    })],
    layouts: [definitionRow('open_field', {
      activity_codes: ['irrigation'],
      supported_templates: ['full_record'],
      option_dependencies: [],
    })],
    products: [],
    mappings: [],
  } as unknown as JournalCatalog;
}

// G3: a fertilization/fertigation draft's attr.product_uuid is a first-class
// visible, required field (see scripts/journal-catalog-core.js) validated
// against catalog.products — DraftResumePanel must thread the real product
// catalog through or the field can never be satisfied.
function productResumeCatalog(): JournalCatalog {
  const product: JournalProductRow = {
    product_uuid: 'prod-1',
    scope: 'farm',
    owner_user_uuid: null,
    gateway_device_eui: null,
    name: 'Test Fertilizer',
    kind: 'mineral',
    active: 1,
    sync_version: 0,
    created_at: '2026-07-18T00:00:00.000Z',
    deleted_at: null,
    catalog_errors: [],
    composition: {},
  };
  return {
    catalog_version: 1,
    catalog_hash: 'product-resume-catalog',
    vocab: [
      vocabRow('fertilization', { kind: 'activity', value_type: null }),
      vocabRow('attr.product_uuid', { value_type: 'text' }),
    ],
    templates: [definitionRow('full_record', {
      fields: [
        { code: 'attr.product_uuid', required: true },
      ],
    })],
    layouts: [definitionRow('open_field', {
      activity_codes: ['fertilization'],
      supported_templates: ['full_record'],
      option_dependencies: [],
    })],
    products: [product],
    mappings: [],
  } as unknown as JournalCatalog;
}

// Deviation 3 fix (2026-07-23): a draft that already carries a value for
// attr.agroscope.operation must resolve fieldStates via the OPERATION-level
// maps (operation_fields_by_operation/operation_requirements), not just the
// broader activity-level fallback (operation_fields_by_activity) — mirrors
// the real full_record@10 operation-level scoping plan at a minimal scale.
// 'op.narrow' is declared as a vocab choice row (kind: 'choice', parent_code:
// 'attr.agroscope.operation') per catalogModel.ts's parser contract; the
// attribute itself never needs to be rendered for this to exercise the bug.
function operationScopedResumeCatalog(): JournalCatalog {
  return {
    catalog_version: 1,
    catalog_hash: 'operation-scoped-resume-catalog',
    vocab: [
      vocabRow('irrigation', { kind: 'activity', value_type: null }),
      vocabRow('attr.wide_field', { value_type: 'text' }),
      vocabRow('attr.narrow_field', { value_type: 'text' }),
      vocabRow('op.narrow', { kind: 'choice', parent_code: 'attr.agroscope.operation', value_type: null }),
    ],
    templates: [definitionRow('full_record', {
      sections: [
        { code: 'operation', scoped_by_activity: true, fields: ['attr.wide_field', 'attr.narrow_field'] },
      ],
      operation_fields_by_activity: { irrigation: ['attr.wide_field'] },
      operation_fields_by_operation: { 'op.narrow': ['attr.narrow_field'] },
      operation_requirements: {
        'op.narrow': { required: ['attr.narrow_field'], required_any: [] },
      },
    })],
    layouts: [definitionRow('open_field', {
      activity_codes: ['irrigation'],
      supported_templates: ['full_record'],
      option_dependencies: [],
    })],
    products: [],
    mappings: [],
  } as unknown as JournalCatalog;
}

function operationValue(operationCode: string) {
  return {
    attribute_code: 'attr.agroscope.operation',
    group_index: 0,
    value_status: 'observed' as const,
    value_num: null,
    value_text: operationCode,
    unit_code: null,
    entered_value_num: null,
    entered_unit_code: null,
  };
}

// M1 fix (2026-07-23): the note textarea is a top-level EntryForm field, not
// a journal_entry_values row -- DraftResumePanel must seed it from
// draft.note and persist an edit back onto the finalize payload's top-level
// `note`, mirroring DetailPanel's correction form.
function notesResumeCatalog(): JournalCatalog {
  return {
    catalog_version: 1,
    catalog_hash: 'notes-resume-catalog',
    vocab: [
      vocabRow('irrigation', { kind: 'activity', value_type: null }),
    ],
    templates: [definitionRow('full_record', {
      sections: [{ code: 'notes', fields: ['note'] }],
    })],
    layouts: [definitionRow('open_field', {
      activity_codes: ['irrigation'],
      supported_templates: ['full_record'],
      option_dependencies: [],
    })],
    products: [],
    mappings: [],
  } as unknown as JournalCatalog;
}

beforeEach(() => {
  useDraftsQueueMock.mockReset();
  useJournalCatalogMock.mockReset();
  useJournalCatalogMock.mockReturnValue({ catalog: undefined, available: false });
  discardDraftMock.mockReset();
  createEntryMock.mockReset();
});

describe('DraftsQueue queue states', () => {
  it('renders a loading state', () => {
    useDraftsQueueMock.mockReturnValue(queueState({ status: 'loading' }));

    render(<DraftsQueue />);

    expect(screen.getByRole('status')).toHaveTextContent('drafts.loading');
  });

  it('renders a retryable error state with no cached drafts', () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    useDraftsQueueMock.mockReturnValue(queueState({ status: 'error', retry }));

    render(<DraftsQueue />);

    expect(screen.getByRole('alert')).toHaveTextContent('drafts.error.title');
    fireEvent.click(screen.getByRole('button', { name: 'drafts.error.retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders a stale banner alongside cached drafts when a refresh failed', () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'stale',
      drafts: [draft('d1')],
      retry,
    }));

    render(<DraftsQueue />);

    expect(screen.getByText('drafts.stale.body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'drafts.resume' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'drafts.stale.retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders an empty state when there are no server drafts', () => {
    useDraftsQueueMock.mockReturnValue(queueState({ status: 'empty' }));

    render(<DraftsQueue />);

    expect(screen.getByText('drafts.empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'drafts.resume' })).not.toBeInTheDocument();
  });

  it('renders every server draft with resume and discard actions', () => {
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1'), draft('d2')],
    }));

    render(<DraftsQueue />);

    expect(screen.getAllByRole('button', { name: 'drafts.resume' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'drafts.discard' })).toHaveLength(2);
  });
});

describe('DraftsQueue discard', () => {
  it('discards a draft and refreshes the queue on success', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    useDraftsQueueMock.mockReturnValue(queueState({ status: 'ready', drafts: [draft('d1')], retry }));
    discardDraftMock.mockResolvedValue({ entry_uuid: 'd1', discarded: true });

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.discard' }));

    await waitFor(() => expect(discardDraftMock).toHaveBeenCalledWith('d1'));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an inline error and keeps the draft when discard fails', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    useDraftsQueueMock.mockReturnValue(queueState({ status: 'ready', drafts: [draft('d1')], retry }));
    discardDraftMock.mockRejectedValue(new Error('offline'));

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.discard' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('drafts.discardError'));
    expect(retry).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'drafts.discard' })).toBeInTheDocument();
  });
});

describe('DraftsQueue resume', () => {
  it('delegates to onResume with the computed focus field and does not open an inline panel', () => {
    const onResume = vi.fn();
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1', { values: [] })],
    }));
    useJournalCatalogMock.mockReturnValue({ catalog: resumeCatalog(), available: true });

    render(<DraftsQueue onResume={onResume} />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.resume' }));

    expect(onResume).toHaveBeenCalledWith('d1', 'attr.required_note');
    expect(screen.queryByLabelText('attr.required_note')).not.toBeInTheDocument();
  });

  it('opens the shared EntryForm inline and focuses the first missing required field', async () => {
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1', { values: [] })],
    }));
    useJournalCatalogMock.mockReturnValue({ catalog: resumeCatalog(), available: true });

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.resume' }));

    await waitFor(() => {
      const target = document.getElementById('attr.required_note');
      expect(target).not.toBeNull();
      expect(target).toHaveFocus();
    });
  });

  it('does not steal focus for an already-satisfied required field', async () => {
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1', {
        values: [{
          attribute_code: 'attr.required_note',
          group_index: 0,
          value_status: 'observed',
          value_num: null,
          value_text: 'already filled in',
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        }],
      })],
    }));
    useJournalCatalogMock.mockReturnValue({ catalog: resumeCatalog(), available: true });

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.resume' }));

    await waitFor(() => expect(document.getElementById('attr.required_note')).not.toBeNull());
    expect(document.getElementById('attr.required_note')).not.toHaveFocus();
  });

  it('shows a graceful fallback when the draft catalog definitions are no longer available', async () => {
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1', { layout_code: 'retired_layout' })],
    }));
    useJournalCatalogMock.mockReturnValue({ catalog: resumeCatalog(), available: true });

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.resume' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('drafts.resumeUnavailable'));
  });

  it('closes the inline resume panel', async () => {
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1', { values: [] })],
    }));
    useJournalCatalogMock.mockReturnValue({ catalog: resumeCatalog(), available: true });

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.resume' }));
    await waitFor(() => expect(document.getElementById('attr.required_note')).not.toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'drafts.close' }));
    });

    expect(document.getElementById('attr.required_note')).not.toBeInTheDocument();
  });
});

describe('DraftsQueue resume complete', () => {
  it('finalizes the draft via journalApi.createEntry once the missing field is filled in', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1', { values: [] })],
      retry,
    }));
    useJournalCatalogMock.mockReturnValue({ catalog: resumeCatalog(), available: true });
    createEntryMock.mockResolvedValue({ entry_uuid: 'd1', outbox_event_uuid: 'evt-1', sync_version: 1 });

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.resume' }));

    await waitFor(() => expect(document.getElementById('attr.required_note')).not.toBeNull());
    fireEvent.change(document.getElementById('attr.required_note') as HTMLInputElement, {
      target: { value: 'filled in' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'drafts.complete' }));
    });

    await waitFor(() => expect(createEntryMock).toHaveBeenCalledTimes(1));
    const payload = createEntryMock.mock.calls[0][0] as {
      entry_uuid?: string;
      status?: string;
      base_sync_version?: number;
      values: Array<{ attribute_code: string }>;
    };
    expect(payload.entry_uuid).toBe('d1');
    expect(payload.status).toBe('final');
    expect(payload.base_sync_version).toBe(0);
    expect(payload.values.some((value) => value.attribute_code === 'attr.required_note')).toBe(true);

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(document.getElementById('attr.required_note')).not.toBeInTheDocument();
  });

  it('blocks Complete while the resumed draft is still invalid', async () => {
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1', { values: [] })],
    }));
    useJournalCatalogMock.mockReturnValue({ catalog: resumeCatalog(), available: true });

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.resume' }));
    await waitFor(() => expect(document.getElementById('attr.required_note')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'drafts.complete' }));

    expect(createEntryMock).not.toHaveBeenCalled();
  });

  it('threads catalog products into a resumed fertilization draft so its product field can be completed (G3)', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1', { activity_code: 'fertilization', values: [] })],
      retry,
    }));
    useJournalCatalogMock.mockReturnValue({ catalog: productResumeCatalog(), available: true });
    createEntryMock.mockResolvedValue({ entry_uuid: 'd1', outbox_event_uuid: 'evt-1', sync_version: 1 });

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.resume' }));

    await waitFor(() => expect(document.getElementById('attr.product_uuid')).not.toBeNull());

    const productSelect = screen.getByRole('combobox', { name: /capture\.form\.product/ });
    fireEvent.change(productSelect, { target: { value: 'prod-1' } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'drafts.complete' })).toBeEnabled());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'drafts.complete' }));
    });

    await waitFor(() => expect(createEntryMock).toHaveBeenCalledTimes(1));
    const payload = createEntryMock.mock.calls[0][0] as {
      values: Array<{ attribute_code: string; value?: unknown }>;
    };
    expect(payload.values.some((value) =>
      value.attribute_code === 'attr.product_uuid' && value.value === 'prod-1')).toBe(true);

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
  });
});

describe('DraftsQueue resume operation scoping (Deviation 3 fix)', () => {
  it('scopes a resumed draft to its stored operation, not the broader activity field set', async () => {
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1', { activity_code: 'irrigation', values: [operationValue('op.narrow')] })],
    }));
    useJournalCatalogMock.mockReturnValue({ catalog: operationScopedResumeCatalog(), available: true });

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.resume' }));

    // The operation-scoped field renders and is the one Complete is blocked
    // on; the activity-level-only field must never appear at all.
    await waitFor(() => expect(document.getElementById('attr.narrow_field')).not.toBeNull());
    expect(document.getElementById('attr.wide_field')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'drafts.complete' })).toBeDisabled();
  });

  it('completes a resumed operation-scoped draft once its operation-required field is filled in', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1', { activity_code: 'irrigation', values: [operationValue('op.narrow')] })],
      retry,
    }));
    useJournalCatalogMock.mockReturnValue({ catalog: operationScopedResumeCatalog(), available: true });
    createEntryMock.mockResolvedValue({ entry_uuid: 'd1', outbox_event_uuid: 'evt-1', sync_version: 1 });

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.resume' }));

    await waitFor(() => expect(document.getElementById('attr.narrow_field')).not.toBeNull());
    fireEvent.change(document.getElementById('attr.narrow_field') as HTMLInputElement, {
      target: { value: 'filled in' },
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'drafts.complete' })).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'drafts.complete' }));
    });

    await waitFor(() => expect(createEntryMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
  });
});

describe('DraftsQueue resume note round-trip (M1 fix)', () => {
  it('prefills the note textarea from the draft\'s stored note', async () => {
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1', { values: [], note: 'half-finished entry, resume later' })],
    }));
    useJournalCatalogMock.mockReturnValue({ catalog: notesResumeCatalog(), available: true });

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.resume' }));

    await waitFor(() => expect(screen.getByLabelText('capture.form.note'))
      .toHaveValue('half-finished entry, resume later'));
  });

  it('persists an edited note on Complete', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    useDraftsQueueMock.mockReturnValue(queueState({
      status: 'ready',
      drafts: [draft('d1', { values: [], note: 'original draft note' })],
      retry,
    }));
    useJournalCatalogMock.mockReturnValue({ catalog: notesResumeCatalog(), available: true });
    createEntryMock.mockResolvedValue({ entry_uuid: 'd1', outbox_event_uuid: 'evt-1', sync_version: 1 });

    render(<DraftsQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'drafts.resume' }));

    await waitFor(() => expect(screen.getByLabelText('capture.form.note')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('capture.form.note'), { target: { value: 'updated draft note' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'drafts.complete' }));
    });

    await waitFor(() => expect(createEntryMock).toHaveBeenCalledTimes(1));
    const payload = createEntryMock.mock.calls[0][0] as { note?: string | null };
    expect(payload.note).toBe('updated draft note');
  });
});
