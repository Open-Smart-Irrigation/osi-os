import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { AppHeader } from '../components/AppHeader';

/**
 * Journal top-level page. The full Slice 2 capture flow and desktop three-pane
 * workspace are in design (docs/design/agrolink-journal-ux.md); this is the
 * aligned landing surface — same crown, glass chrome, and Journal tab active —
 * so the navigation is real while the entry UI is built.
 */
export const JournalPage: React.FC = () => {
  const { t } = useTranslation('journal');
  const { username, logout } = useAuth();

  const cards = [
    { k: 'capture', title: t('comingSoon.captureTitle'), body: t('comingSoon.captureBody') },
    { k: 'record', title: t('comingSoon.recordTitle'), body: t('comingSoon.recordBody') },
    { k: 'sync', title: t('comingSoon.syncTitle'), body: t('comingSoon.syncBody') },
  ];

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <AppHeader
        title={t('title')}
        activeTab="journal"
        username={username}
        onLogout={logout}
      />

      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 shadow-sm">
          <span className="inline-flex items-center gap-2 rounded-full bg-[var(--warn-bg)] px-3 py-1 text-xs font-bold uppercase tracking-widest text-[var(--warn-text)]">
            {t('comingSoon.badge')}
          </span>
          <h2 className="mt-4 text-2xl font-bold text-[var(--text)]">{t('comingSoon.heading')}</h2>
          <p className="mt-3 max-w-prose text-[var(--text-secondary)]">{t('comingSoon.body')}</p>

          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {cards.map((c) => (
              <div key={c.k} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <h3 className="text-sm font-bold text-[var(--text)]">{c.title}</h3>
                <p className="mt-1.5 text-sm text-[var(--text-secondary)]">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
};
