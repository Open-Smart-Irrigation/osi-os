import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PlotGroup } from '../../../types/journal';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';

export interface HarvestGroupNudgeProps {
  groups: readonly PlotGroup[];
  onResolve: (group: PlotGroup) => Promise<void>;
  errors: ReadonlyMap<string, string>;
}

const ERROR_COPY = {
  'group.resolveError': 'Could not resolve this group.',
  'group.changedError': 'This group changed. Refresh and try again.',
} as const;

type ResolutionErrorKey = keyof typeof ERROR_COPY;

function safeErrorKey(value: string | undefined): ResolutionErrorKey | null {
  if (!value) return null;
  return value === 'group.changedError' ? value : 'group.resolveError';
}

export function HarvestGroupNudge({ groups, onResolve, errors }: HarvestGroupNudgeProps) {
  const { t } = useTranslation('journal');
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const inFlightRef = useRef(new Set<string>());
  const resolvedRef = useRef(new Set<string>());

  if (groups.length === 0) return null;

  const resolve = async (group: PlotGroup) => {
    const uuid = group.group_uuid;
    if (inFlightRef.current.has(uuid) || resolvedRef.current.has(uuid)) return;
    inFlightRef.current.add(uuid);
    setPending((current) => new Set(current).add(uuid));
    setFailed((current) => {
      const next = new Set(current);
      next.delete(uuid);
      return next;
    });
    try {
      await onResolve(group);
      resolvedRef.current.add(uuid);
      setResolved((current) => new Set(current).add(uuid));
    } catch {
      setFailed((current) => new Set(current).add(uuid));
    } finally {
      inFlightRef.current.delete(uuid);
      setPending((current) => {
        const next = new Set(current);
        next.delete(uuid);
        return next;
      });
    }
  };

  return (
    <section
      aria-label={t('group.resolutionRegion', { defaultValue: 'Harvest group resolution' })}
      className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4"
    >
      <h2 className="font-bold text-[var(--text)]">
        {t('group.resolveHeading', { defaultValue: 'Resolve harvest group' })}
      </h2>
      <ul className="space-y-3">
        {groups.map((group) => {
          const isPending = pending.has(group.group_uuid);
          const isResolved = resolved.has(group.group_uuid);
          const errorKey = safeErrorKey(errors.get(group.group_uuid))
            ?? (failed.has(group.group_uuid) ? 'group.resolveError' : null);
          const actionLabel = `${t('group.resolveAction', { defaultValue: 'Resolve group' })} ${group.label}`;
          return (
            <li key={group.group_uuid} className="rounded-xl border border-[var(--border)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold text-[var(--text)]">{group.label}</h3>
                  <p className="text-sm text-[var(--text-secondary)]">
                    {t('group.members', {
                      count: group.members.length,
                      defaultValue: `${group.members.length} plots`,
                    })}
                  </p>
                </div>
                {!isResolved && (
                  <button
                    type="button"
                    aria-label={actionLabel}
                    disabled={isPending}
                    onClick={() => { void resolve(group); }}
                    className={`min-h-[56px] rounded-xl bg-[var(--primary)] px-4 font-bold text-white disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
                  >
                    {isPending
                      ? t('group.resolving', { defaultValue: 'Resolving…' })
                      : t('group.resolveAction', { defaultValue: 'Resolve group' })}
                  </button>
                )}
              </div>
              {isPending && (
                <p role="status" className="mt-2 text-sm font-semibold text-[var(--text-secondary)]">
                  {t('group.resolving', { defaultValue: 'Resolving…' })}
                </p>
              )}
              {isResolved && (
                <p role="status" className="mt-2 text-sm font-semibold text-[var(--text-secondary)]">
                  {t('group.resolved', { defaultValue: 'Resolved' })}
                </p>
              )}
              {!isPending && !isResolved && errorKey && (
                <p role="alert" className="mt-2 text-sm font-semibold text-[var(--error-text)]">
                  {t(errorKey, { defaultValue: ERROR_COPY[errorKey] })}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
