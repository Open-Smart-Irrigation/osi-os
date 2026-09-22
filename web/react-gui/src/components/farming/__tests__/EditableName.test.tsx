import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditableName } from '../shared/EditableName';

// t() returns the key itself, matching this codebase's convention
// (Sdi12SoilCard.test.tsx, CreateZoneModal.uicore.test.tsx).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const PENCIL = 'rename.device';
const INPUT = 'rename.deviceInputLabel';

function renderName(overrides: {
  name?: string;
  canEdit?: boolean;
  onSave?: (name: string) => Promise<void>;
} = {}) {
  const onSave = overrides.onSave ?? vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined);
  render(
    <EditableName
      name={overrides.name ?? 'North block'}
      canEdit={overrides.canEdit ?? true}
      onSave={onSave}
      renameLabel={PENCIL}
      inputLabel={INPUT}
      headingClassName="truncate text-base font-semibold"
    />,
  );
  return { onSave };
}

function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: PENCIL }));
  return screen.getByLabelText(INPUT);
}

describe('EditableName read mode', () => {
  it('renders the heading with the caller classes and a pencil when editing is allowed', () => {
    renderName();
    const heading = screen.getByRole('heading', { name: 'North block' });
    expect(heading.className).toContain('truncate');
    expect(screen.getByRole('button', { name: PENCIL })).toBeInTheDocument();
  });

  it('hides the pencil when editing is not allowed', () => {
    renderName({ canEdit: false });
    expect(screen.getByRole('heading', { name: 'North block' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PENCIL })).not.toBeInTheDocument();
  });
});

describe('EditableName saving', () => {
  it('saves the trimmed value on Enter', async () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: '  South block  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('South block'));
    await waitFor(() => expect(screen.getByRole('button', { name: PENCIL })).toBeInTheDocument());
  });

  it('saves on blur', async () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('South block'));
  });

  it('calls onSave once for Enter and the blur Enter causes', async () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it('calls onSave once for a fast double trigger', async () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it('closes without saving when the name did not change', async () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: '  North block  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('button', { name: PENCIL })).toBeInTheDocument());
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('EditableName cancelling', () => {
  it('restores the name and focuses the pencil on Escape', () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'North block' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PENCIL })).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('EditableName focus after close', () => {
  it('leaves focus where the operator moved it after a blur-initiated save', async () => {
    const { onSave } = renderName();
    render(<button type="button">Other</button>);
    const other = screen.getByRole('button', { name: 'Other' });
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    other.focus();
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('South block'));
    await waitFor(() => expect(screen.getByRole('button', { name: PENCIL })).toBeInTheDocument());
    expect(other).toHaveFocus();
  });

  it('returns focus to the pencil after an Enter-initiated save', async () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('South block'));
    await waitFor(() => expect(screen.getByRole('button', { name: PENCIL })).toHaveFocus());
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('EditableName rejection', () => {
  it('blocks a blank name client-side', () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('rename.reason.name_empty');
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText(INPUT)).toBeInTheDocument();
  });

  it('blocks an over-long name client-side', () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'a'.repeat(101) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('rename.reason.name_too_long');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('ties the error to the input for assistive technology', () => {
    renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const alert = screen.getByRole('alert');
    expect(alert.id).toBeTruthy();
    expect(screen.getByLabelText(INPUT)).toHaveAttribute('aria-describedby', alert.id);
  });

  it('shows the translated reason a rejected save carries', async () => {
    const failure = Object.assign(new Error('Name is too long'), { reason: 'name_too_long' });
    const { onSave } = renderName({ onSave: vi.fn().mockRejectedValue(failure) });
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('rename.reason.name_too_long'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(INPUT)).toBeInTheDocument();
  });

  it('falls back to the generic failure text for an error with no known reason', async () => {
    renderName({ onSave: vi.fn().mockRejectedValue(new Error('Network Error')) });
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('rename.failed'));
  });

  it('allows a second attempt after a rejection', async () => {
    const onSave = vi.fn<(name: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValueOnce(undefined);
    renderName({ onSave });
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    fireEvent.keyDown(screen.getByLabelText(INPUT), { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });
});
