// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {fireEvent, render, screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, expect, it, vi} from 'vitest';
import {api} from '../../services/api';
import {createDemoAdapter} from '../../../demo/adapter';
import {Simulator} from '../../../demo/model';
import {AccountLink} from '../AccountLink';

vi.mock('react-i18next', () => ({useTranslation: () => ({t: (key: string) => key})}));

afterEach(() => {
  delete document.documentElement.dataset.publicSimulator;
  api.defaults.adapter = undefined;
});

it('discards public login and registration credentials after unlink and reopening the form', async () => {
  document.documentElement.dataset.publicSimulator = 'true';
  const sim = new Simulator({mode: 'public'});
  api.defaults.adapter = createDemoAdapter(sim);
  const view = render(<MemoryRouter><AccountLink /></MemoryRouter>);
  await screen.findByText('status.notLinked');
  const usernameInput = () => view.container.querySelector('input[type="text"]') as HTMLInputElement;
  const emailInput = () => view.container.querySelector('input[type="email"]') as HTMLInputElement;
  const passwordInput = () => view.container.querySelector('input[type="password"]') as HTMLInputElement;

  const linkAndUnlink = async (action: 'login' | 'register', username: string, email?: string) => {
    if (action === 'register') {
      fireEvent.click(view.container.querySelector('input[type="radio"][value="register"]')!);
      fireEvent.change(emailInput(), {target: {value: email}});
    }
    fireEvent.change(usernameInput(), {target: {value: username}});
    fireEvent.change(passwordInput(), {target: {value: 'discard-this-secret'}});
    fireEvent.submit(usernameInput().closest('form')!);
    fireEvent.click(await screen.findByRole('button', {name: 'warning.proceed'}));
    await screen.findByText('success.title');

    fireEvent.click(screen.getByRole('button', {name: 'unlink.button'}));
    fireEvent.click(screen.getByRole('button', {name: 'unlink.button'}));
    await screen.findByText('status.notLinked');

    expect(passwordInput().value).toBe('');
    if (action === 'register') expect(emailInput().value).toBe('');
  };

  await linkAndUnlink('login', 'fictional-login');
  await linkAndUnlink('register', 'fictional-registration', 'discard-this-email@example.test');
  expect(await sim.request('GET', '/api/account-link/status')).toMatchObject({linked: false});
});
