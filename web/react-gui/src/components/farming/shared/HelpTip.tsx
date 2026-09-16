import React, { useId, useState } from 'react';

interface HelpTipProps {
  /** Tip text. One or two sentences; anything longer belongs inline. */
  children: React.ReactNode;
  /** Accessible name for the toggle, e.g. "About 5 V warm-up time". */
  label: string;
}

const FOCUS_VISIBLE_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]';

/**
 * A disclosure, not a hover tooltip: the tip opens on click, tap, Enter or
 * Space and stays open until it is dismissed again. Hover-only tips are
 * unreachable on the touchscreens this dashboard is mostly used from, and a
 * `title` attribute is unreachable from the keyboard.
 *
 * Renders a fragment so the panel becomes a sibling of the trigger: inside a
 * `flex flex-wrap` label row `basis-full` drops it onto its own line, and
 * inside a block container it simply stacks underneath.
 */
export const HelpTip: React.FC<HelpTipProps> = ({ children, label }) => {
  const [open, setOpen] = useState(false);
  const tipId = useId();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={tipId}
        aria-label={label}
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[11px] font-bold leading-none text-[var(--text-secondary)] transition-colors hover:bg-[var(--secondary-bg)] ${FOCUS_VISIBLE_RING}`}
      >
        ?
      </button>
      {open && (
        <p
          id={tipId}
          role="note"
          className="mt-2 w-full basis-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--text-secondary)]"
        >
          {children}
        </p>
      )}
    </>
  );
};
