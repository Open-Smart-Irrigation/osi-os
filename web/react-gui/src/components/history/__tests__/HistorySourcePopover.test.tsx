import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { HistorySourcePopover } from '../mobile/HistorySourcePopover';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'history.sources.button') return 'Sources';
      if (key === 'history.sources.menuLabel') return 'Card sources';
      return key;
    },
  }),
}));

describe('HistorySourcePopover', () => {
  it('is hidden for one source and toggles multiple source checkboxes', () => {
    const { rerender } = render(
      <HistorySourcePopover
        sources={[{ key: 'a', name: 'Chameleon 1' }]}
        enabledKeys={['a']}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /sources/i })).not.toBeInTheDocument();

    const onChange = vi.fn();
    rerender(
      <HistorySourcePopover
        sources={[
          { key: 'a', name: 'Chameleon 1' },
          { key: 'b', name: 'Chameleon 2' },
        ]}
        enabledKeys={['a', 'b']}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /sources/i }));
    fireEvent.click(screen.getByLabelText('Chameleon 2'));

    expect(onChange).toHaveBeenCalledWith(['a']);
  });
});
