import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ENTITY_NAME_MAX, normalizeEntityName, type EntityNameReason } from '../../../utils/entityName';

export interface EditableNameProps {
  name: string;
  canEdit: boolean;
  /** Rejects with an error carrying `reason?: string` when the route answers 400. */
  onSave: (name: string) => Promise<void>;
  /** aria-label and title of the pencil button. */
  renameLabel: string;
  /** aria-label of the text input. */
  inputLabel: string;
  /** The read-mode heading's classes, so each card keeps its own look. */
  headingClassName?: string;
}

// The reason codes the routes send, typed by EntityNameReason so a code that
// the rule does not define is a compile error here. A string from a newer
// gateway that is not one of them falls back to the generic failure text
// instead of rendering a raw key.
const REASON_CODES: ReadonlySet<string> = new Set<EntityNameReason>([
  'name_empty',
  'name_too_long',
  'name_control_characters',
  'name_invalid_unicode',
]);

// A predicate rather than a plain `.has()` test: it narrows the runtime string
// to the union, which makes `rename.reason.${reason}` an ordinary typed key
// for react-i18next's typed t() instead of the wider
// `` `rename.reason.${string}` ``. Without it the call needed a
// `{ defaultValue }` overload carrying a second copy of the four English
// sentences, free to drift from the locale bundles that actually ship.
function isEntityNameReason(value: string): value is EntityNameReason {
  return REASON_CODES.has(value);
}

// The treatment the ⚙ control next to the name already uses (Sdi12SoilCard.tsx),
// so the pencil sits on the same 48 px target its neighbour does.
const PENCIL_CLASS =
  'touch-target shrink-0 rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors ' +
  'hover:bg-[var(--card)] hover:text-[var(--text)] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]';

// ui-core's INPUT_CLASS tokens (--card, --field-border, --focus, --text) in the
// compact form a card heading row needs. INPUT_CLASS itself is the modal
// treatment (px-4 py-4 text-lg) and would be taller than the card header.
const INPUT_CLASS_COMPACT =
  'touch-target w-full rounded-lg border-2 border-[var(--field-border)] bg-[var(--card)] ' +
  'px-2 py-1 text-base text-[var(--text)] ' +
  'focus:border-[var(--focus)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)]';

export const EditableName: React.FC<EditableNameProps> = ({
  name,
  canEdit,
  onSave,
  renameLabel,
  inputLabel,
  headingClassName,
}) => {
  const { t } = useTranslation('devices');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const pencilRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refs, not state: all three guards are read and written inside one event
  // handler, before React has re-rendered.
  //   saving       — one in-flight save. Enter closes the editor, which blurs
  //                  the input, and the blur handler would otherwise save the
  //                  same value a second time.
  //   suppressBlur — the blur that closing the editor causes belongs to the
  //                  close, not to a new save attempt. Escape and a successful
  //                  save both set it.
  //   restoreFocus — the pencil is unmounted while editing, so focus can only
  //                  be returned after the next render.
  const savingRef = useRef(false);
  const suppressBlurRef = useRef(false);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      pencilRef.current?.focus();
    }
  }, [editing]);

  // restoreFocus is false only for a blur-initiated close: the operator has
  // already moved focus somewhere else (Tab, a click on another control), and
  // it must stay there. Escape and Enter both unmount the input while it
  // holds focus, so those close paths return focus to the pencil; otherwise
  // the browser would drop it to the document body.
  const closeEditor = useCallback((restoreFocus: boolean) => {
    suppressBlurRef.current = true;
    restoreFocusRef.current = restoreFocus;
    setError(null);
    setEditing(false);
  }, []);

  const startEdit = useCallback(() => {
    suppressBlurRef.current = false;
    setDraft(name);
    setError(null);
    setEditing(true);
  }, [name]);

  // restoreFocus travels down from whichever path triggered the commit: true
  // for Enter (the input is about to unmount while focused), false for blur
  // (the operator already moved focus and it must not be pulled back).
  const commit = useCallback(async (restoreFocus: boolean) => {
    if (savingRef.current) return;

    const result = normalizeEntityName(draft);
    if (!result.ok) {
      setError(t(`rename.reason.${result.reason}`));
      return;
    }
    if (result.name === name) {
      closeEditor(restoreFocus);
      return;
    }

    savingRef.current = true;
    try {
      await onSave(result.name);
      closeEditor(restoreFocus);
    } catch (caught) {
      const reason = (caught as { reason?: unknown } | null | undefined)?.reason;
      setError(
        typeof reason === 'string' && isEntityNameReason(reason)
          ? t(`rename.reason.${reason}`)
          : t('rename.failed'),
      );
    } finally {
      savingRef.current = false;
    }
  }, [closeEditor, draft, name, onSave, t]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit(true);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(name);
      closeEditor(true);
    }
  };

  const handleBlur = () => {
    if (suppressBlurRef.current) {
      suppressBlurRef.current = false;
      return;
    }
    void commit(false);
  };

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        {/* min-w-0 is what lets the caller's `truncate` still shrink now that
            the heading sits inside a flex row of its own. */}
        <h3 className={headingClassName ? `min-w-0 ${headingClassName}` : 'min-w-0'}>{name}</h3>
        {canEdit && (
          <button
            type="button"
            ref={pencilRef}
            onClick={startEdit}
            aria-label={renameLabel}
            title={renameLabel}
            className={PENCIL_CLASS}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              aria-hidden="true"
              focusable="false"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M11.5 1.8a1.7 1.7 0 0 1 2.7 2.7L5.4 13.3 1.8 14.2l0.9-3.6 8.8-8.8Z" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        aria-label={inputLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        // The attribute counts UTF-16 units, the rule counts code points, and
        // 100 code points are at most 200 units — so this cap can never cut a
        // name the rule accepts. normalizeEntityName enforces the real limit.
        maxLength={ENTITY_NAME_MAX * 2}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className={INPUT_CLASS_COMPACT}
      />
      {error && (
        <p id={errorId} role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {error}
        </p>
      )}
    </div>
  );
};
