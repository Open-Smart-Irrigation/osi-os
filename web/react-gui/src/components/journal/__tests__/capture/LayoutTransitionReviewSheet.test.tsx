// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => `${key}:${options?.defaultValue ?? ''}`,
  }),
}));

import { buildCatalogModel } from '../../../../journal/catalogModel';
import { LayoutTransitionReviewSheet } from '../../capture/LayoutTransitionReviewSheet';
import type { LayoutTransitionAffectedItem } from '../../../../journal/layoutTransition';
import type { JournalCatalog, JournalVocabRow } from '../../../../types/journal';

const timestamp = '2026-07-19T00:00:00.000Z';

function row(code: string, overrides: Partial<JournalVocabRow> = {}): JournalVocabRow {
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
    created_at: timestamp,
    deleted_at: null,
    catalog_errors: [],
    labels: { en: code },
    constraints: null,
    ...overrides,
  };
}

function choiceRow(code: string, parentCode: string, label: string): JournalVocabRow {
  return row(code, { kind: 'choice', parent_code: parentCode, value_type: null, labels: { en: label } });
}

const catalog: JournalCatalog = {
  catalog_version: 1,
  catalog_hash: 'sheet',
  vocab: [
    row('attr.note', { labels: { en: 'Note' } }),
    row('attr.method', { value_type: 'choice', labels: { en: 'Method' } }),
    choiceRow('method.b', 'attr.method', 'Method B'),
  ],
  templates: [],
  layouts: [],
  products: [],
  mappings: [],
};

function model() {
  const result = buildCatalogModel(catalog);
  if (!result.ok) throw new Error('bad fixture');
  return result.model;
}

function hiddenItem(): LayoutTransitionAffectedItem {
  return {
    attribute_code: 'attr.note',
    group_index: 0,
    reason: 'field_hidden',
    value: { attribute_code: 'attr.note', value: 'temporary detail' },
  };
}

function invalidChoiceItem(): LayoutTransitionAffectedItem {
  return {
    attribute_code: 'attr.method',
    group_index: 0,
    reason: 'choice_invalid',
    value: { attribute_code: 'attr.method', value: 'method.b' },
  };
}

afterEach(() => {
  cleanup();
});

describe('LayoutTransitionReviewSheet', () => {
  it('renders nothing when there are no affected items', () => {
    const { container } = render(<LayoutTransitionReviewSheet
      items={[]}
      model={model()}
      locale="en"
      onResolve={vi.fn()}
      onRequestClose={vi.fn()}
    />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one row per affected item with its label, reason, and current value', () => {
    render(<LayoutTransitionReviewSheet
      items={[hiddenItem(), invalidChoiceItem()]}
      model={model()}
      locale="en"
      onResolve={vi.fn()}
      onRequestClose={vi.fn()}
    />);

    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText('Note')).toBeVisible();
    expect(screen.getByText('temporary detail')).toBeVisible();
    expect(screen.getByText('Method')).toBeVisible();
    expect(screen.getByText('Method B')).toBeVisible();
  });

  it('resolves an item as kept-under-the-old-setting without altering its value', () => {
    const onResolve = vi.fn();
    render(<LayoutTransitionReviewSheet
      items={[hiddenItem()]}
      model={model()}
      locale="en"
      onResolve={onResolve}
      onRequestClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: /keep.*note/i }));
    expect(onResolve).toHaveBeenCalledWith(hiddenItem(), 'kept');
  });

  it('resolves an item as replaced', () => {
    const onResolve = vi.fn();
    render(<LayoutTransitionReviewSheet
      items={[invalidChoiceItem()]}
      model={model()}
      locale="en"
      onResolve={onResolve}
      onRequestClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: /replace.*method/i }));
    expect(onResolve).toHaveBeenCalledWith(invalidChoiceItem(), 'replaced');
  });

  it('resolves an item as removed', () => {
    const onResolve = vi.fn();
    render(<LayoutTransitionReviewSheet
      items={[hiddenItem()]}
      model={model()}
      locale="en"
      onResolve={onResolve}
      onRequestClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: /remove.*note/i }));
    expect(onResolve).toHaveBeenCalledWith(hiddenItem(), 'removed');
  });

  it('moves focus into the sheet on open and returns it to the triggering control on close', () => {
    const opener = document.createElement('button');
    opener.textContent = 'open';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = render(<LayoutTransitionReviewSheet
      items={[hiddenItem()]}
      model={model()}
      locale="en"
      onResolve={vi.fn()}
      onRequestClose={vi.fn()}
    />);

    expect(document.activeElement).not.toBe(opener);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('closes on Escape', () => {
    const onRequestClose = vi.fn();
    render(<LayoutTransitionReviewSheet
      items={[hiddenItem()]}
      model={model()}
      locale="en"
      onResolve={vi.fn()}
      onRequestClose={onRequestClose}
    />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onRequestClose).toHaveBeenCalled();
  });

  it('closes via the explicit close control', () => {
    const onRequestClose = vi.fn();
    render(<LayoutTransitionReviewSheet
      items={[hiddenItem()]}
      model={model()}
      locale="en"
      onResolve={vi.fn()}
      onRequestClose={onRequestClose}
    />);

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onRequestClose).toHaveBeenCalled();
  });

  it('distinguishes the hidden-field reason from the invalid-choice reason in copy', () => {
    render(<LayoutTransitionReviewSheet
      items={[hiddenItem(), invalidChoiceItem()]}
      model={model()}
      locale="en"
      onResolve={vi.fn()}
      onRequestClose={vi.fn()}
    />);

    expect(screen.getByText(/capture\.transition\.reasonFieldHidden/)).toBeVisible();
    expect(screen.getByText(/capture\.transition\.reasonChoiceInvalid/)).toBeVisible();
  });
});
