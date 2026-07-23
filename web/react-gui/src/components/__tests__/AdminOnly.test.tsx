import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminOnly } from '../AdminOnly';

const scopeState = vi.hoisted(() => ({ loading: false, isAdmin: true }));
vi.mock('../../contexts/ScopeContext', () => ({ useScope: () => scopeState }));

function renderGate() {
  render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route path="/" element={<p>Dashboard</p>} />
        <Route path="/admin" element={<AdminOnly><p>Admin content</p></AdminOnly>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AdminOnly', () => {
  beforeEach(() => {
    scopeState.loading = false;
    scopeState.isAdmin = true;
  });

  it('waits for scope and then renders admins', () => {
    scopeState.loading = true;
    const { rerender } = render(
      <MemoryRouter><AdminOnly><p>Admin content</p></AdminOnly></MemoryRouter>,
    );
    expect(screen.queryByText('Admin content')).not.toBeInTheDocument();
    scopeState.loading = false;
    rerender(<MemoryRouter><AdminOnly><p>Admin content</p></AdminOnly></MemoryRouter>);
    expect(screen.getByText('Admin content')).toBeInTheDocument();
  });

  it('redirects non-admins to the dashboard', () => {
    scopeState.isAdmin = false;
    renderGate();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Admin content')).not.toBeInTheDocument();
  });
});
