// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { AnalysisViewsMenu } from '../AnalysisViewsMenu';
import type { AnalysisViewResponse } from '../../../analysis/types';

const views: AnalysisViewResponse[] = [
  {
    id: 5,
    name: 'Stress sweep',
    schemaVersion: 1,
    isDefault: false,
    updatedAt: 't',
    viewJson: {
      schemaVersion: 1,
      selectors: [],
      range: { mode: 'relative', label: '7d', from: null, to: null },
      mode: 'timeline',
      layout: 'stacked',
      toggles: { normalize: false },
    },
  },
];

afterEach(cleanup);

describe('AnalysisViewsMenu', () => {
  it('saves with the entered name and clears the input', () => {
    const onSave = vi.fn();
    render(<AnalysisViewsMenu views={[]} onSave={onSave} onLoad={vi.fn()} onDelete={vi.fn()} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '  My view  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'analysis.views.save' }));
    expect(onSave).toHaveBeenCalledWith('My view');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('disables save when the name is blank', () => {
    render(<AnalysisViewsMenu views={[]} onSave={vi.fn()} onLoad={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'analysis.views.save' })).toBeDisabled();
  });

  it('loads and deletes a saved view', () => {
    const onLoad = vi.fn();
    const onDelete = vi.fn();
    render(<AnalysisViewsMenu views={views} onSave={vi.fn()} onLoad={onLoad} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stress sweep' }));
    expect(onLoad).toHaveBeenCalledWith(views[0]);
    fireEvent.click(screen.getByRole('button', { name: 'analysis.views.delete' }));
    expect(onDelete).toHaveBeenCalledWith(5);
  });

  it('hides delete controls when no delete handler is provided', () => {
    render(<AnalysisViewsMenu views={views} onSave={vi.fn()} onLoad={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'analysis.views.delete' })).not.toBeInTheDocument();
  });
});
