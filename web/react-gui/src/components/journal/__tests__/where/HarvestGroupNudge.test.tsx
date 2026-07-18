// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PlotGroup } from '../../../../types/journal';
import { HarvestGroupNudge } from '../../where/HarvestGroupNudge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      `${key}:${options?.defaultValue ?? ''}`,
  }),
}));

const timestamp = '2026-07-18T00:00:00.000Z';

function group(overrides: Partial<PlotGroup> = {}): PlotGroup {
  return {
    contract_version: 1,
    group_uuid: 'group-1',
    label: 'North block',
    owner_user_uuid: 'owner',
    gateway_device_eui: 'gateway',
    created_by_principal_uuid: 'author',
    created_at: timestamp,
    resolved_at: null,
    resolved_by_principal_uuid: null,
    sync_version: 7,
    deleted_at: null,
    members: ['plot-b', 'plot-a'],
    ...overrides,
  };
}

describe('HarvestGroupNudge', () => {
  it('renders one accessible opt-in action per group in supplied order', () => {
    render(<HarvestGroupNudge
      groups={[group({ group_uuid: 'a', label: 'Alpha' }), group({ group_uuid: 'b', label: 'Beta' })]}
      onResolve={vi.fn(async () => undefined)}
      errors={new Map()}
    />);

    expect(screen.getAllByRole('button', { name: /resolve/i })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /resolve.*alpha/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /resolve.*beta/i })).toBeVisible();
    expect(screen.getByRole('region', {
      name: 'group.resolutionRegion:Harvest group resolution',
    })).toBeVisible();
    expect(screen.getByRole('heading', {
      name: 'group.resolveHeading:Resolve harvest group',
    })).toBeVisible();
    expect(screen.getByRole('button', {
      name: 'group.resolveAction:Resolve group Alpha',
    })).toBeVisible();
  });

  it('blocks a same-act double invocation before pending state commits', async () => {
    let resolve: (() => void) | undefined;
    const onResolve = vi.fn(() => new Promise<void>((finish) => { resolve = finish; }));
    render(<HarvestGroupNudge groups={[group()]} onResolve={onResolve} errors={new Map()} />);

    const button = screen.getByRole('button', { name: /resolve.*north block/i });
    act(() => {
      button.click();
      button.click();
    });

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('group.resolving:Resolving…');

    resolve?.();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('group.resolved:Resolved'));
  });

  it('keeps a failed group visible with an adjacent error and allows retry', async () => {
    const onResolve = vi.fn()
      .mockRejectedValueOnce(new Error('gateway unavailable'))
      .mockResolvedValueOnce(undefined);
    const { rerender } = render(<HarvestGroupNudge
      groups={[group()]}
      onResolve={onResolve}
      errors={new Map()}
    />);

    const button = screen.getByRole('button', { name: /resolve.*north block/i });
    fireEvent.click(button);
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));

    rerender(<HarvestGroupNudge
      groups={[group()]}
      onResolve={onResolve}
      errors={new Map([['group-1', 'group.resolveError']])}
    />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'group.resolveError:Could not resolve this group.',
    );
    expect(screen.getByRole('button', { name: /resolve.*north block/i })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /resolve.*north block/i }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(2));
  });

  it('does not render a stale error while a retry is resolving', () => {
    const onResolve = vi.fn(() => new Promise<void>(() => undefined));
    render(<HarvestGroupNudge
      groups={[group()]}
      onResolve={onResolve}
      errors={new Map([['group-1', 'group.resolveError']])}
    />);

    expect(screen.getByRole('alert')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /resolve.*north block/i }));

    expect(screen.getByRole('status')).toHaveTextContent('group.resolving:Resolving…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['Error rejection', new Error('database conflict for owner@example.test')],
    ['object rejection', { message: 'raw backend detail', owner: 'owner@example.test' }],
  ])('maps %s to safe fallback copy', async (_label, rejection) => {
    const onResolve = vi.fn().mockRejectedValue(rejection);
    render(<HarvestGroupNudge groups={[group()]} onResolve={onResolve} errors={new Map()} />);

    fireEvent.click(screen.getByRole('button', { name: /resolve.*north block/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('group.resolveError:Could not resolve this group.');
    expect(alert).not.toHaveTextContent('database conflict');
    expect(alert).not.toHaveTextContent('raw backend detail');
    expect(alert).not.toHaveTextContent('owner@example.test');
  });

  it('renders the planned changed-group key with safe default copy', () => {
    render(<HarvestGroupNudge
      groups={[group()]}
      onResolve={vi.fn(async () => undefined)}
      errors={new Map([['group-1', 'group.changedError']])}
    />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'group.changedError:This group changed. Refresh and try again.',
    );
  });

  it('does not add an apply-to-all action or resolve groups automatically', () => {
    const onResolve = vi.fn(async () => undefined);
    render(<HarvestGroupNudge groups={[group()]} onResolve={onResolve} errors={new Map()} />);

    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /apply to all/i })).not.toBeInTheDocument();
  });
});
