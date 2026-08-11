import React from 'react';
import { useTranslation } from 'react-i18next';

interface ReadOnlyNoticeProps {
  /**
   * `farm` — the whole page is read-only for this user; mount ONCE per page.
   * `section` — only this section is, while the rest of the page is editable.
   */
  scope: 'farm' | 'section';
  className?: string;
}

/**
 * One explanation per surface, never one per control (maintainer decision 3(c),
 * S6). The edge hid controls at 18 sites with zero explanation; eighteen inline
 * notices would be clutter and would fight decision 3(a), which says a card
 * absent because no such device is connected is CORRECT and must stay silent.
 * So: a viewer learns "you have read-only access to this farm" once, and the
 * absence of a dendrometer card still says nothing, because there is nothing
 * to say.
 *
 * info tone, not warn: in a fail-closed product amber means "you cannot
 * write"; spending it on a stable, expected state devalues the signal. Uses
 * this branch's own --info-* tokens directly (no ui-core Banner dependency --
 * that primitive is deliberately not vendored on this branch).
 */
export const ReadOnlyNotice: React.FC<ReadOnlyNoticeProps> = ({ scope, className }) => {
  const { t } = useTranslation('common');
  return (
    <div
      role="status"
      className={`rounded-lg border border-[var(--info-border)] bg-[var(--info-bg)] px-4 py-3 text-sm text-[var(--info-text)]${className ? ` ${className}` : ''}`}
    >
      {t(`readOnly.${scope}`)}
    </div>
  );
};
