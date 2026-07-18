// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JournalPlot, JournalPlotWritePayload } from '../../../../types/journal';
import { PlotForm } from '../../where/PlotForm';

const translationMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      translationMock(key, options);
      return String(options?.defaultValue ?? key);
    },
  }),
}));

const timestamp = '2026-07-18T00:00:00.000Z';

function plot(overrides: Partial<JournalPlot> = {}): JournalPlot {
  return {
    contract_version: 1,
    plot_uuid: 'plot-existing',
    plot_code: 'P-1',
    name: 'North field',
    zone_uuid: 'zone-1',
    station_code: 'A',
    crop_hint: 'Wheat',
    area_m2: 120,
    active: 1,
    sync_version: 9,
    owner_user_uuid: 'owner-1',
    gateway_device_eui: 'ABCDEF0123456789',
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    settings: {
      layout_code: 'grid',
      updated_at: timestamp,
      updated_by_principal_uuid: 'owner-1',
      sync_version: 9,
    },
    ...overrides,
  };
}

const layoutOptions = [
  { code: 'grid', version: 2, label: 'Grid layout' },
  { code: 'open_field', version: 1, label: 'Open field' },
] as const;

function renderForm(overrides: Partial<React.ComponentProps<typeof PlotForm>> = {}) {
  const props: React.ComponentProps<typeof PlotForm> = {
    mode: 'create',
    layoutOptions,
    onSubmit: vi.fn().mockResolvedValue(plot({ plot_uuid: 'plot-created' })),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { ...render(<PlotForm {...props} />), props };
}

function selectLayout(code = 'grid'): void {
  fireEvent.change(screen.getByRole('combobox', { name: 'Layout' }), {
    target: { value: code },
  });
}

function submit(): void {
  const form = screen.getByRole('heading', { name: /plot/i }).closest('form');
  expect(form).not.toBeNull();
  fireEvent.submit(form as HTMLFormElement);
}

function fillCompleteCreateForm(): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'Plot code' }), {
    target: { value: 'P-12' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: 'South field' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Zone' }), {
    target: { value: 'zone-12' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Station' }), {
    target: { value: 'B' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Crop hint' }), {
    target: { value: 'Barley' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Area (m²)' }), {
    target: { value: '240.5' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Active' }));
  selectLayout();
}

function apiFailure(error: string, message: string) {
  return {
    response: { data: { error, message, details: null } },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function enterDistinctiveConflictValues(): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'Plot code' }), {
    target: { value: 'CONFLICT-77' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: 'Conflict test field' },
  });
  selectLayout('open_field');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Active' }));
}

describe('PlotForm', () => {
  beforeEach(() => {
    translationMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates with crypto.randomUUID and base version zero', async () => {
    const createdUuid = '11111111-1111-4111-8111-111111111111';
    const randomUuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(createdUuid);
    const failure = apiFailure('plot_code_conflict', 'That plot code is already in use.');
    const onCancel = vi.fn();
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(plot({ plot_uuid: createdUuid }));
    const { rerender } = renderForm({ onSubmit, onCancel });
    fillCompleteCreateForm();
    rerender(<PlotForm
      mode="create"
      layoutOptions={layoutOptions}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />);

    expect(screen.getByRole('textbox', { name: 'Plot code' })).toHaveValue('P-12');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('South field');
    expect(screen.getByRole('combobox', { name: 'Layout' })).toHaveValue('grid');
    expect(screen.getByRole('checkbox', { name: 'Active' })).not.toBeChecked();

    submit();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('plot_code_conflict'));
    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(randomUuid).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual(expect.objectContaining({
      plot_uuid: createdUuid,
      base_sync_version: 0,
    }));
    expect(onSubmit.mock.calls[1][0]).toEqual(expect.objectContaining({
      plot_uuid: createdUuid,
      base_sync_version: 0,
    }));
  });

  it('sends exactly the shipped plot fields', async () => {
    const onSubmit = vi.fn().mockResolvedValue(plot({ plot_uuid: 'plot-create-uuid' }));
    renderForm({ onSubmit });
    fillCompleteCreateForm();
    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0] as JournalPlotWritePayload;
    expect(Object.keys(payload).sort()).toEqual([
      'active',
      'area_m2',
      'base_sync_version',
      'crop_hint',
      'layout_code',
      'layout_version',
      'name',
      'plot_code',
      'plot_uuid',
      'station_code',
      'zone_uuid',
    ]);
    expect(payload).toEqual({
      plot_uuid: expect.any(String),
      base_sync_version: 0,
      plot_code: 'P-12',
      name: 'South field',
      zone_uuid: 'zone-12',
      station_code: 'B',
      crop_hint: 'Barley',
      area_m2: 240.5,
      active: 0,
      layout_code: 'grid',
      layout_version: 2,
    });
  });

  it('updates with the existing UUID and current sync version', async () => {
    const onSubmit = vi.fn().mockResolvedValue(plot());
    renderForm({ mode: 'update', initialPlot: plot(), onSubmit });
    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      plot_uuid: 'plot-existing',
      base_sync_version: 9,
      plot_code: 'P-1',
      name: 'North field',
      zone_uuid: 'zone-1',
      station_code: 'A',
      crop_hint: 'Wheat',
      area_m2: 120,
      active: 1,
      layout_code: 'grid',
      layout_version: 2,
    });
  });

  it('reinitializes every field and identity when create switches to a different update plot', async () => {
    const onSubmit = vi.fn().mockResolvedValue(plot());
    const onCancel = vi.fn();
    const { rerender } = renderForm({ onSubmit, onCancel });

    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('Select an active layout before saving.');
    fillCompleteCreateForm();

    const updatePlot = plot({
      plot_uuid: 'plot-update-2',
      plot_code: 'UPDATE-2',
      name: 'Update identity field',
      zone_uuid: 'zone-update-2',
      station_code: 'ST-9',
      crop_hint: 'Rye',
      area_m2: 987.25,
      active: 0,
      sync_version: 17,
      settings: {
        ...plot().settings,
        layout_code: 'open_field',
        sync_version: 17,
      },
    });
    rerender(<PlotForm
      mode="update"
      initialPlot={updatePlot}
      layoutOptions={layoutOptions}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Plot code' })).toHaveValue('UPDATE-2');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Update identity field');
    expect(screen.getByRole('textbox', { name: 'Zone' })).toHaveValue('zone-update-2');
    expect(screen.getByRole('textbox', { name: 'Station' })).toHaveValue('ST-9');
    expect(screen.getByRole('textbox', { name: 'Crop hint' })).toHaveValue('Rye');
    expect(screen.getByRole('textbox', { name: 'Area (m²)' })).toHaveValue('987.25');
    expect(screen.getByRole('checkbox', { name: 'Active' })).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Layout' })).toHaveValue('open_field');

    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      plot_uuid: 'plot-update-2',
      base_sync_version: 17,
      plot_code: 'UPDATE-2',
      name: 'Update identity field',
      zone_uuid: 'zone-update-2',
      station_code: 'ST-9',
      crop_hint: 'Rye',
      area_m2: 987.25,
      active: 0,
      layout_code: 'open_field',
      layout_version: 1,
    });
  });

  it('retains edits for an ordinary update rerender and resets them for a new update identity', async () => {
    const onSubmit = vi.fn().mockResolvedValue(plot());
    const onCancel = vi.fn();
    const firstPlot = plot();
    const secondPlot = plot({
      plot_uuid: 'plot-second',
      plot_code: 'SECOND-2',
      name: 'Second identity',
      active: 0,
      sync_version: 23,
      settings: { ...plot().settings, layout_code: 'open_field', sync_version: 23 },
    });
    const { rerender } = renderForm({
      mode: 'update',
      initialPlot: firstPlot,
      onSubmit,
      onCancel,
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Plot code' }), {
      target: { value: 'UNSAVED-EDIT' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Unsaved field edit' },
    });

    rerender(<PlotForm
      mode="update"
      initialPlot={{ ...firstPlot }}
      layoutOptions={layoutOptions}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />);
    expect(screen.getByRole('textbox', { name: 'Plot code' })).toHaveValue('UNSAVED-EDIT');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Unsaved field edit');

    rerender(<PlotForm
      mode="update"
      initialPlot={secondPlot}
      layoutOptions={layoutOptions}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Plot code' })).toHaveValue('SECOND-2'));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Second identity');
    expect(screen.getByRole('combobox', { name: 'Layout' })).toHaveValue('open_field');
    expect(screen.getByRole('checkbox', { name: 'Active' })).not.toBeChecked();

    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      plot_uuid: 'plot-second',
      base_sync_version: 23,
      plot_code: 'SECOND-2',
      name: 'Second identity',
      active: 0,
      layout_code: 'open_field',
      layout_version: 1,
    }));
  });

  it('requires an explicit catalog layout and never selects open_field silently', () => {
    const onSubmit = vi.fn().mockResolvedValue(plot());
    const { rerender } = renderForm({ onSubmit });
    expect(screen.getByRole('combobox', { name: 'Layout' })).toHaveValue('');
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Select an active layout before saving.');

    rerender(<PlotForm
      mode="update"
      initialPlot={plot({ settings: { ...plot().settings, layout_code: 'retired' } })}
      layoutOptions={layoutOptions}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />);
    expect(screen.getByRole('combobox', { name: 'Layout' })).toHaveValue('');
  });

  it('disables every input and Cancel while the mutation is pending', async () => {
    const mutation = deferred<JournalPlot>();
    const onSubmit = vi.fn(() => mutation.promise);
    renderForm({ mode: 'update', initialPlot: plot(), onSubmit });

    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    for (const control of [
      ...screen.getAllByRole('textbox'),
      ...screen.getAllByRole('combobox'),
      ...screen.getAllByRole('checkbox'),
      screen.getByRole('button', { name: 'Cancel' }),
      screen.getByRole('button', { name: 'Saving…' }),
    ]) {
      expect(control).toBeDisabled();
    }
  });

  it('keeps a superseded plot attempt from mutating or calling back into the new identity', async () => {
    const plotAMutation = deferred<JournalPlot>();
    const plotBMutation = deferred<JournalPlot>();
    const onSubmitA = vi.fn(() => plotAMutation.promise);
    const onSubmitB = vi.fn(() => plotBMutation.promise);
    const onAfterSaveA = vi.fn();
    const onAfterSaveB = vi.fn();
    const onCancel = vi.fn();
    const plotB = plot({
      plot_uuid: 'plot-b',
      plot_code: 'P-B',
      name: 'Plot B',
      sync_version: 14,
    });
    const { rerender } = renderForm({
      mode: 'update',
      initialPlot: plot(),
      onSubmit: onSubmitA,
      onAfterSave: onAfterSaveA,
      onCancel,
    });

    submit();
    await waitFor(() => expect(onSubmitA).toHaveBeenCalledTimes(1));
    rerender(<PlotForm
      mode="update"
      initialPlot={plotB}
      layoutOptions={layoutOptions}
      onSubmit={onSubmitB}
      onAfterSave={onAfterSaveB}
      onCancel={onCancel}
    />);

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Plot code' })).toHaveValue('P-B'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    submit();
    await waitFor(() => expect(onSubmitB).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    await act(async () => {
      plotAMutation.resolve(plot({ plot_uuid: 'plot-existing' }));
      await plotAMutation.promise;
    });
    expect(onAfterSaveA).not.toHaveBeenCalled();
    expect(onAfterSaveB).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Plot code' })).toHaveValue('P-B');

    await act(async () => {
      plotBMutation.resolve(plotB);
      await plotBMutation.promise;
    });
    await waitFor(() => expect(onAfterSaveB).toHaveBeenCalledWith(plotB));
    expect(onAfterSaveA).not.toHaveBeenCalled();
  });

  it('does not surface a stale mutation failure after the form identity changes', async () => {
    const plotAMutation = deferred<JournalPlot>();
    const onSubmitA = vi.fn(() => plotAMutation.promise);
    const plotB = plot({
      plot_uuid: 'plot-b-failure-isolation',
      plot_code: 'P-B-FAILURE-ISOLATION',
    });
    const { rerender } = renderForm({
      mode: 'update',
      initialPlot: plot(),
      onSubmit: onSubmitA,
    });

    submit();
    await waitFor(() => expect(onSubmitA).toHaveBeenCalledTimes(1));
    rerender(<PlotForm
      mode="update"
      initialPlot={plotB}
      layoutOptions={layoutOptions}
      onSubmit={vi.fn().mockResolvedValue(plotB)}
      onCancel={vi.fn()}
    />);

    await act(async () => {
      plotAMutation.reject(apiFailure('stale_version', 'Plot A is stale'));
      await expect(plotAMutation.promise).rejects.toEqual(
        apiFailure('stale_version', 'Plot A is stale'),
      );
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Plot code' })).toHaveValue('P-B-FAILURE-ISOLATION');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('does not run stale callbacks when unmounted before mutation settlement', async () => {
    const mutation = deferred<JournalPlot>();
    const onSubmit = vi.fn(() => mutation.promise);
    const onAfterSave = vi.fn();
    const { unmount } = renderForm({
      mode: 'update',
      initialPlot: plot(),
      onSubmit,
      onAfterSave,
    });
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {
      mutation.resolve(plot());
      await mutation.promise;
    });

    expect(onAfterSave).not.toHaveBeenCalled();
  });

  it('keeps a committed save usable for Cancel when onAfterSave rejects', async () => {
    const onSubmit = vi.fn().mockResolvedValue(plot({ plot_uuid: 'saved-plot' }));
    const onAfterSave = vi.fn().mockRejectedValue(new Error('Parent close failed'));
    renderForm({ onSubmit, onAfterSave });
    fireEvent.change(screen.getByRole('textbox', { name: 'Plot code' }), {
      target: { value: 'COMMITTED-1' },
    });
    selectLayout();

    submit();
    await waitFor(() => expect(onAfterSave).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Plot code' })).toHaveValue('COMMITTED-1');
    expect(translationMock).not.toHaveBeenCalledWith('plot.error', expect.anything());
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onAfterSave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('keeps a committed save usable for Cancel when onAfterSave is absent', async () => {
    const onSubmit = vi.fn().mockResolvedValue(plot({ plot_uuid: 'saved-without-callback' }));
    const onCancel = vi.fn();
    renderForm({ onSubmit, onCancel });
    fireEvent.change(screen.getByRole('textbox', { name: 'Plot code' }), {
      target: { value: 'COMMITTED-ABSENT' },
    });
    selectLayout();

    submit();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Plot code' })).toHaveValue('COMMITTED-ABSENT');
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('blocks whitespace-only plot code with visible associated feedback and focuses it', () => {
    const onSubmit = vi.fn().mockResolvedValue(plot());
    renderForm({ onSubmit });
    const code = screen.getByRole('textbox', { name: 'Plot code' });
    fireEvent.change(code, { target: { value: '   ' } });
    selectLayout();

    submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(code).toHaveValue('   ');
    expect(code).toBeRequired();
    expect(code).toHaveAttribute('aria-invalid', 'true');
    const describedBy = code.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent('Plot code *');
    expect(screen.getByText('Plot code *')).toBeVisible();
    expect(document.activeElement).toBe(code);
  });

  it('marks a missing layout invalid with native required semantics', () => {
    const onSubmit = vi.fn().mockResolvedValue(plot());
    renderForm({ onSubmit });
    const layout = screen.getByRole('combobox', { name: 'Layout' });

    submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(layout).toBeRequired();
    expect(layout).toHaveAttribute('aria-invalid', 'true');
  });

  it('maps a blank area to null while keeping the area as an honest text input', async () => {
    const onSubmit = vi.fn().mockResolvedValue(plot());
    renderForm({ onSubmit });
    const code = screen.getByRole('textbox', { name: 'Plot code' });
    const layout = screen.getByRole('combobox', { name: 'Layout' });
    const area = screen.getByRole('textbox', { name: 'Area (m²)' });
    fireEvent.change(code, { target: { value: 'AREA-BLANK' } });
    selectLayout();

    expect(code).toBeRequired();
    expect(layout).toBeRequired();
    expect(area).not.toHaveAttribute('role');
    expect(area).not.toHaveAttribute('min');
    expect(area).not.toHaveAttribute('step');
    expect(code.closest('form')).not.toHaveAttribute('novalidate');
    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ area_m2: null }));
  });

  it.each(['0', '-5', '1e309'])(
    'blocks and retains invalid nonblank area %s',
    (areaValue) => {
      const onSubmit = vi.fn().mockResolvedValue(plot());
      renderForm({ onSubmit });
      fireEvent.change(screen.getByRole('textbox', { name: 'Plot code' }), {
        target: { value: 'AREA-INVALID' },
      });
      const area = screen.getByRole('textbox', { name: 'Area (m²)' });
      fireEvent.change(area, { target: { value: areaValue } });
      selectLayout();

      submit();

      expect(onSubmit).not.toHaveBeenCalled();
      expect(area).toHaveAttribute('aria-invalid', 'true');
      expect((area as HTMLInputElement).value).toBe(areaValue);
      const describedBy = area.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy as string)).toHaveTextContent('Area (m²): > 0');
      expect(screen.getByText('Area (m²): > 0')).toBeVisible();
      expect(document.activeElement).toBe(area);
    },
  );

  it('focuses invalid fields in code, area, then layout order', () => {
    const onSubmit = vi.fn().mockResolvedValue(plot());
    renderForm({ onSubmit });
    const code = screen.getByRole('textbox', { name: 'Plot code' });
    const area = screen.getByRole('textbox', { name: 'Area (m²)' });
    const layout = screen.getByRole('combobox', { name: 'Layout' });

    fireEvent.change(code, { target: { value: 'VALID-CODE' } });
    fireEvent.change(area, { target: { value: '0' } });
    submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(area).toHaveAttribute('aria-invalid', 'true');
    expect(layout).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(area);

    fireEvent.change(area, { target: { value: '12' } });
    submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(layout).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(layout);
  });

  it('gives two mounted forms unique IDs and local label and error associations', () => {
    const { container } = render(<>
      <PlotForm
        mode="create"
        layoutOptions={layoutOptions}
        onSubmit={vi.fn().mockResolvedValue(plot())}
        onCancel={vi.fn()}
      />
      <PlotForm
        mode="create"
        layoutOptions={layoutOptions}
        onSubmit={vi.fn().mockResolvedValue(plot())}
        onCancel={vi.fn()}
      />
    </>);
    const forms = screen.getAllByRole('form', { name: 'New plot' });
    expect(forms).toHaveLength(2);
    const firstCode = within(forms[0]).getByRole('textbox', { name: 'Plot code' });
    const secondCode = within(forms[1]).getByRole('textbox', { name: 'Plot code' });
    expect(firstCode.id).not.toBe(secondCode.id);
    expect(within(forms[0]).getByText('Plot code', { selector: 'label' })).toHaveAttribute('for', firstCode.id);
    expect(within(forms[1]).getByText('Plot code', { selector: 'label' })).toHaveAttribute('for', secondCode.id);

    fireEvent.submit(forms[0]);
    fireEvent.submit(forms[1]);
    const firstAlert = within(forms[0]).getByRole('alert');
    const secondAlert = within(forms[1]).getByRole('alert');
    expect(firstAlert.id).not.toBe(secondAlert.id);
    expect(forms[0]).toHaveAttribute('aria-labelledby', within(forms[0]).getByRole('heading').id);
    expect(forms[1]).toHaveAttribute('aria-labelledby', within(forms[1]).getByRole('heading').id);
    expect(forms[0]).toHaveAttribute('aria-describedby', firstAlert.id);
    expect(forms[1]).toHaveAttribute('aria-describedby', secondAlert.id);
    expect(within(forms[0]).getByRole('combobox', { name: 'Layout' })).toHaveAttribute('aria-describedby', firstAlert.id);
    expect(within(forms[1]).getByRole('combobox', { name: 'Layout' })).toHaveAttribute('aria-describedby', secondAlert.id);

    const ids = [...container.querySelectorAll<HTMLElement>('[id]')].map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    {
      name: 'plot code conflict',
      error: 'plot_code_conflict',
      message: 'Plot code is already in use',
      translationKey: 'plot.codeConflict',
      defaultValue: 'Plot code is already in use.',
    },
    {
      name: 'stale version',
      error: 'stale_version',
      message: 'Plot version is stale',
      translationKey: 'plot.stale',
      defaultValue: 'This plot changed elsewhere. Reload before saving.',
    },
    {
      name: 'heterogeneous group',
      error: 'heterogeneous_group',
      message: 'Layout change would make an unresolved plot group heterogeneous',
      translationKey: 'plot.heterogeneousGroup',
      defaultValue: 'The plot belongs to a heterogeneous group.',
    },
    {
      name: 'plot in unresolved group',
      error: 'plot_in_unresolved_group',
      message: 'Resolve or edit the plot group before deactivating this plot',
      translationKey: 'plot.unresolvedGroup',
      defaultValue: 'Resolve the plot group before deactivating this plot.',
    },
  ])('preserves entered values after the $name Axios response', async ({
    error,
    message,
    translationKey,
    defaultValue,
  }) => {
    const onSubmit = vi.fn().mockRejectedValue(apiFailure(error, message));
    renderForm({ mode: 'update', initialPlot: plot(), onSubmit });
    enterDistinctiveConflictValues();
    submit();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(error));
    expect(translationMock).toHaveBeenCalledWith(translationKey, { defaultValue });
    expect(screen.getByRole('textbox', { name: 'Plot code' })).toHaveValue('CONFLICT-77');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Conflict test field');
    expect(screen.getByRole('combobox', { name: 'Layout' })).toHaveValue('open_field');
    expect(screen.getByRole('checkbox', { name: 'Active' })).not.toBeChecked();
  });

  it('uses 56px labels and controls', () => {
    const { container } = renderForm();

    expect(container.querySelectorAll('label')).not.toHaveLength(0);
    for (const label of container.querySelectorAll('label')) {
      expect(label).toHaveClass('min-h-[56px]');
    }
    for (const control of [
      ...screen.getAllByRole('textbox'),
      ...screen.getAllByRole('combobox'),
      ...screen.getAllByRole('checkbox'),
      ...screen.getAllByRole('button'),
    ]) {
      expect(control).toHaveClass('min-h-[56px]');
      expect(control.className).toContain('focus-visible:');
    }
  });

  it('awaits the supplied mutation before optional close notification', async () => {
    let resolveSubmit!: (value: JournalPlot) => void;
    const mutation = new Promise<JournalPlot>((resolve) => {
      resolveSubmit = resolve;
    });
    const events: string[] = [];
    const onSubmit = vi.fn(() => {
      events.push('submit');
      return mutation;
    });
    const onAfterSave = vi.fn(async (saved: JournalPlot) => {
      events.push(`after:${saved.plot_uuid}`);
    });
    renderForm({ onSubmit, onAfterSave });
    fireEvent.change(screen.getByRole('textbox', { name: 'Plot code' }), {
      target: { value: 'ASYNC-1' },
    });
    selectLayout();

    submit();
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onAfterSave).not.toHaveBeenCalled();

    resolveSubmit(plot({ plot_uuid: 'saved-plot' }));
    await waitFor(() => expect(onAfterSave).toHaveBeenCalledWith(expect.objectContaining({
      plot_uuid: 'saved-plot',
    })));
    expect(events).toEqual(['submit', 'after:saved-plot']);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });
});
