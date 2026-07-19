import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntryAggregate, JournalCatalog, JournalDefinitionRow, JournalVocabRow } from '../../../types/journal';
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

const { discardDraftMock } = vi.hoisted(() => ({ discardDraftMock: vi.fn() }));
vi.mock('../../../services/journalApi', () => ({
  journalApi: { discardDraft: (uuid: string) => discardDraftMock(uuid) },
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
    occurred_timezone: 'Europe/Zurich',
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

beforeEach(() => {
  useDraftsQueueMock.mockReset();
  useJournalCatalogMock.mockReset();
  useJournalCatalogMock.mockReturnValue({ catalog: undefined, available: false });
  discardDraftMock.mockReset();
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
