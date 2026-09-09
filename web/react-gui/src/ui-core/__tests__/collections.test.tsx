// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyState, TableShell } from '../index';

afterEach(cleanup);

describe('TableShell', () => {
  it('renders headers inside the bordered scroll container', () => {
    render(
      <TableShell headers={['Username', 'Role']}>
        <tr>
          <td className="p-4">amina</td>
          <td className="p-4">admin</td>
        </tr>
      </TableShell>,
    );
    expect(screen.getByRole('table').querySelectorAll('th')).toHaveLength(2);
    expect(screen.getByText('amina')).toBeTruthy();
  });
});

describe('EmptyState', () => {
  it('renders title, subtitle and centered actions', () => {
    render(
      <EmptyState title="No devices yet" subtitle="Add your first device">
        <button type="button">Add device</button>
      </EmptyState>,
    );
    expect(screen.getByText('No devices yet').className).toContain('font-bold');
    expect(screen.getByRole('button', { name: 'Add device' })).toBeTruthy();
  });
});
