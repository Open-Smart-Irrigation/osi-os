import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import en from '../../../public/locales/en/settings.json';
import fr from '../../../public/locales/fr/settings.json';
import { installFakeNetwork, ok, resetSession, restoreNetwork, type FakeNetwork } from '../../contexts/__tests__/sessionHarness';
import { UsersPage } from '../admin/UsersPage';

let network: FakeNetwork;
const user = { username: 'a-long-local-username', user_uuid: 'local-uuid', role: 'researcher', disabled_at: null, created_at: '2026-01-01T00:00:00Z', auth_mode: 'local' };

beforeEach(() => {
  resetSession();
  network = installFakeNetwork();
  network.on('GET', '/api/users', () => ok({ users: [user] }));
});
afterEach(() => { cleanup(); restoreNetwork(); localStorage.clear(); });

async function renderPage(language = 'fr', waitForUser = true) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({ lng: language, fallbackLng: 'en', defaultNS: 'settings', resources: { en: { settings: en }, fr: { settings: fr } }, interpolation: { escapeValue: false } });
  render(<I18nextProvider i18n={i18n}><MemoryRouter><UsersPage /></MemoryRouter></I18nextProvider>);
  if (waitForUser) await screen.findByText(user.username);
  return i18n;
}

describe('B3 Users labels and controls', () => {
  it('switches page, form, table and contextual labels without changing role values', async () => {
    const i18n = await renderPage('en');
    await act(async () => { await i18n.changeLanguage('fr'); });
    expect(screen.getByRole('heading', { name: 'Utilisateurs' })).toBeInTheDocument();
    expect(screen.getByLabelText('Mot de passe temporaire')).toBeInTheDocument();
    const role = screen.getByRole('combobox', { name: `Rôle de ${user.username}` });
    expect(role).toHaveValue('researcher');
    expect(within(role).getByRole('option', { name: 'Administrateur' })).toHaveValue('admin');
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Désactiver' })).toBeInTheDocument();
    expect(screen.getByText('Activé')).toBeInTheDocument();
  });

  it('localizes visible reset labels and mismatch validation; a mismatch sends nothing', async () => {
    const i18n = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Réinitialiser le mot de passe' }));
    expect(screen.getByRole('heading', { name: `Réinitialiser le mot de passe de ${user.username}` })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Nouveau mot de passe temporaire'), { target: { value: 'new-test-value' } });
    fireEvent.change(screen.getByLabelText('Confirmer le mot de passe temporaire'), { target: { value: 'different-test-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le mot de passe' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Les mots de passe ne correspondent pas.');
    expect(network.to('POST', '/api/users/local-uuid/password-reset')).toHaveLength(0);
    await act(async () => { await i18n.changeLanguage('en'); });
    expect(screen.getByRole('alert')).toHaveTextContent('The passwords do not match.');
    expect(screen.getByLabelText('New temporary password')).toHaveValue('new-test-value');
  });

  it('preserves create, role, disabled and password-reset payloads', async () => {
    network.on('POST', '/api/users', () => ok(user));
    network.on('PUT', '/api/users/local-uuid/role', () => ok({}));
    network.on('PUT', '/api/users/local-uuid/disabled', () => ok({}));
    network.on('POST', '/api/users/local-uuid/password-reset', () => ok({}));
    await renderPage();
    fireEvent.change(screen.getByLabelText('Nom d’utilisateur'), { target: { value: 'new-local-user' } });
    fireEvent.change(screen.getByLabelText('Mot de passe temporaire'), { target: { value: 'temporary-test-value' } });
    fireEvent.change(screen.getByLabelText('Rôle'), { target: { value: 'viewer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Créer un utilisateur' }));
    await waitFor(() => expect(network.to('POST', '/api/users')).toHaveLength(1));
    expect(network.to('POST', '/api/users')[0].body).toEqual({ username: 'new-local-user', password: 'temporary-test-value', role: 'viewer' });
    fireEvent.change(screen.getByRole('combobox', { name: `Rôle de ${user.username}` }), { target: { value: 'admin' } });
    await waitFor(() => expect(network.to('PUT', '/api/users/local-uuid/role')).toHaveLength(1));
    expect(network.to('PUT', '/api/users/local-uuid/role')[0].body).toEqual({ role: 'admin' });
    fireEvent.click(screen.getByRole('button', { name: 'Désactiver' }));
    await waitFor(() => expect(network.to('PUT', '/api/users/local-uuid/disabled')).toHaveLength(1));
    expect(network.to('PUT', '/api/users/local-uuid/disabled')[0].body).toEqual({ disabled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Réinitialiser le mot de passe' }));
    for (const label of ['Nouveau mot de passe temporaire', 'Confirmer le mot de passe temporaire']) fireEvent.change(screen.getByLabelText(label), { target: { value: 'replacement-test-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le mot de passe' }));
    await waitFor(() => expect(network.to('POST', '/api/users/local-uuid/password-reset')).toHaveLength(1));
    expect(network.to('POST', '/api/users/local-uuid/password-reset')[0].body).toEqual({ password: 'replacement-test-value' });
  });

  it.each(['empty', 'failed'])('keeps localized loading, form and headers for a %s list fixture', async (outcome) => {
    network.on('GET', '/api/users', () => 'defer');
    await renderPage('fr', false);
    expect(screen.getByText('Chargement des utilisateurs…')).toBeInTheDocument();
    await act(async () => {
      const request = network.to('GET', '/api/users')[0];
      if (outcome === 'empty') request.respond({ users: [] });
      else request.fail(404, { message: 'Not found' });
    });
    expect(screen.queryByText('Chargement des utilisateurs…')).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Nom d’utilisateur' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Créer un utilisateur' })).toBeInTheDocument();
    if (outcome === 'failed') expect(screen.getByRole('alert')).toHaveTextContent('Not found');
    else expect(screen.queryByRole('alert')).toBeNull();
  });

  // jsdom cannot measure CSS geometry. These guards cover the shrink/scroll
  // contract; browser fixtures verify the resulting layout and contrast.
  it('keeps form controls shrinkable and exposes keyboard table scrolling', async () => {
    await renderPage('en');
    const field = screen.getByLabelText('Username');
    expect(field).toHaveClass('min-w-0', 'w-full', 'border-[var(--field-border)]');
    expect(field.parentElement).toHaveClass('min-w-0');
    expect(field.closest('form')).toHaveClass('sm:grid-cols-2', 'lg:grid-cols-4');
    const region = screen.getByRole('region', { name: 'Users' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveClass('overflow-x-auto');
    expect(region).toHaveAccessibleDescription('Scroll horizontally to see all user details and actions.');
  });
});
