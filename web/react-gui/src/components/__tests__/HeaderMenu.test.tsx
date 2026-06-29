import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeaderMenu } from '../HeaderMenu';

afterEach(cleanup);

function renderMenu(onSelect = vi.fn()) {
  render(
    <BrowserRouter>
      <HeaderMenu
        label="Account"
        triggerClassName="bg-slate-900"
        items={[
          { key: 'srv', label: 'OSI Server', to: '/account-link' },
          { key: 'logout', label: 'Logout', onSelect },
        ]}
      />
    </BrowserRouter>,
  );
  return onSelect;
}

describe('HeaderMenu (osi-os)', () => {
  it('opens on click; link item has href; action item runs onSelect and closes', () => {
    const onSelect = renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('menuitem', { name: 'OSI Server' })).toHaveAttribute('href', '/account-link');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Logout' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menuitem', { name: 'Logout' })).not.toBeInTheDocument();
  });

  it('fills its wrapper so compact header buttons align consistently', () => {
    renderMenu();
    expect(screen.getByRole('button', { name: 'Account' })).toHaveClass('w-full');
  });

  it('uses the shared header menu surface color', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('menu')).toHaveClass('bg-[var(--surface)]');
  });

  it('focuses the first item on open', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('menuitem', { name: 'OSI Server' })).toHaveFocus();
  });

  it('Escape closes and returns focus to the trigger', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Account' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'OSI Server' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('ArrowDown moves focus to the next item', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Logout' })).toHaveFocus();
  });

  it('closes when focus leaves the menu (Tab away)', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.blur(screen.getByRole('menuitem', { name: 'OSI Server' }), { relatedTarget: document.body });
    expect(screen.queryByRole('menuitem', { name: 'OSI Server' })).not.toBeInTheDocument();
  });
});
