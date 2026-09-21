import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ENTITY_NAME_MAX, normalizeEntityName } from '../../../utils/entityName';

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

// Task 14 lands the `rename.*` keys in public/locales/*/devices.json; until
// then they are absent from en_devices, so react-i18next's resource-typed
// `t()` overload rejects every literal below at compile time. An `as
// TranslationKey` cast (rather than reaching for `t()`'s `{ defaultValue }`
// overload, the pattern ScheduleSection.tsx's swtMetricLabel uses for a key
// mid-migration) is deliberate: tests/i18nDefaultValueCoverage.test.ts
// specifically forbids a defaultValue for a key no locale file defines yet,
// because that would silently ship the defaultValue text as the string in
// all seven languages once Task 13 starts rendering this component (the F35
// defect class). No options object reaches `t()` from this file, so that
// guard has nothing to see, and the missing key renders through
// react-i18next's own missing-key fallback (the raw key) until Task 14 lands
// the real strings. `any` is the honest type here: `t()`'s key type is a
// closed union built from the current devices.json, and these keys are not
// in it yet.
type TranslationKey = any;

// The reason codes the routes send. An unknown string from a newer gateway
// falls back to the generic failure text instead of rendering a raw key.
const REASON_CODES: ReadonlySet<string> = new Set([
  'name_empty',
  'name_too_long',
  'name_control_characters',
  'name_invalid_unicode',
]);

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

  // A rename that lands from elsewhere (the SWR poll, another browser) must
  // reach the heading. While the operator is typing, the draft wins.
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [editing, name]);

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

  const closeEditor = useCallback(() => {
    suppressBlurRef.current = true;
    restoreFocusRef.current = true;
    setError(null);
    setEditing(false);
  }, []);

  const startEdit = useCallback(() => {
    suppressBlurRef.current = false;
    setDraft(name);
    setError(null);
    setEditing(true);
  }, [name]);

  const commit = useCallback(async () => {
    if (savingRef.current) return;

    const result = normalizeEntityName(draft);
    if (!result.ok) {
      setError(t(`rename.reason.${result.reason}` as TranslationKey));
      return;
    }
    if (result.name === name) {
      closeEditor();
      return;
    }

    savingRef.current = true;
    try {
      await onSave(result.name);
      closeEditor();
    } catch (caught) {
      const reason = (caught as { reason?: unknown } | null | undefined)?.reason;
      setError(
        typeof reason === 'string' && REASON_CODES.has(reason)
          ? t(`rename.reason.${reason}` as TranslationKey)
          : t('rename.failed' as TranslationKey),
      );
    } finally {
      savingRef.current = false;
    }
  }, [closeEditor, draft, name, onSave, t]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(name);
      closeEditor();
    }
  };

  const handleBlur = () => {
    if (suppressBlurRef.current) {
      suppressBlurRef.current = false;
      return;
    }
    void commit();
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
