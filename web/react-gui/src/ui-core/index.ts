// Partial vendored slice of the AgroLink `ui-core` package.
//
// fcf70de4 (the two-tab zone device modal) depends on ui-core, which lives on
// feat/journal-cloud-primary as a 15-file design system. Only the three primitives below are
// actually imported by the cherry-picked components, so only those are vendored here.
//
// Deliberately NOT brought across: tokens.css and tailwind-preset.js. These components are
// thin wrappers that read CSS custom properties and import no CSS of their own, so on this
// branch they consume the Bovey branding tokens in src/index.css rather than a second,
// competing token set. The two tokens ui-core needs that this branch lacked (--field-border,
// --on-primary) were added to index.css instead, with ui-core's own values.
//
// The three .tsx files are byte-identical to fcf70de4 so a later full ui-core parity merge
// reconciles cleanly. Add the remaining primitives here as they are actually needed.
export { Button } from './Button';
export type { ButtonProps, ButtonVariant } from './Button';
export { FormField, INPUT_CLASS } from './FormField';
export type { FormFieldProps } from './FormField';
export { Modal } from './Modal';
export type { ModalProps } from './Modal';
