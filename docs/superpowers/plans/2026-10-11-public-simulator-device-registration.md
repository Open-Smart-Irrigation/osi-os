# Public simulator device registration adjustment

User requirement: every supported catalog device must be addable through the standard OSI OS workflow. Prefill a randomly generated DevEUI so visitors only type the device name; retain device type selection and normal optional configuration, validation and submission. This adjustment is part of the first public version, not deferred to the expanded realism branch.

## Scope and behavior

- Keep the existing nine-type catalog and real native Add Device and zone Register Device forms, handlers, name validation, type selection, optional AppKey, Strega generation, zone association and success/error callbacks.
- Only the public simulator prefills DevEUI. Production and FAO presentation forms retain their current behavior. Use the existing compiled public flag and check production build isolation; no demo imports into production components.
- Generate a fresh valid uppercase 16-hex identifier for each new public registration opening, using browser crypto.getRandomValues. Use a locally assigned fictional prefix and reserve generated values for the document lifetime so repeat opens do not reuse them. Never fabricate vendor-issued identity or call a real provisioning service. Standard duplicate validation remains active; no backend validation bypass.
- Keep generated DevEUI visible and editable. Do not change it when the visitor edits a name or selects a different device type. Fresh reopening generates another value, including after a successful add; failed submission retains the entered values.
- Optional AppKey remains optional and blank, matching the current native workflow. No real credentials or device keys are needed. Selecting a nondefault device type remains the native dropdown interaction; visitors need only type a name.
- Existing public device factories/readings remain the source of behavior for all types. Expanded specialist models and ready-configured companion sensor defaults remain separate until their accepted integration.

## Ownership

Luna implements after Astra plan GREEN. Root owns builds/browser sessions/index/commits. Own only:

- new web/react-gui/src/utils/publicSimulatorDeviceDefaults.ts
- web/react-gui/src/components/farming/AddDeviceModal.tsx
- web/react-gui/src/components/farming/ZoneDeviceModal.tsx
- their two existing __tests__/*.test.tsx files
- new web/react-gui/demo/tests/public/registration.spec.ts
- this plan and a durable bounded review record

The new browser file joins the final public gate as a sixth selected file; the original five remain mandatory. No changes to existing R2 release.spec.ts or concurrent badge source. No dependency changes.

## Execution and evidence

1. Write meaningful mounted form tests before product edits. Actual RED must show missing public prefill/name-only submission in both forms. Cover a different value after reopen, stability on type/name edits and failed submit, editable value, optional key, and unchanged nonpublic behavior. Test shared generation collision retry using controlled crypto only where necessary; do not add implementation-mirroring tests.
2. Implement the shared bounded generator and the two public-only form defaults. Preserve normal callbacks and cancellation.
3. Add real browser acceptance using the existing public host and native controls, without adapter replacement: iterate all nine catalog types through Add Device, enter only each name, retain/assert prefilled distinct identifiers, submit, reopen the native device list and read the added type/name/identity. Also register a device through the existing zone form and assert its zone membership. Keep native Pixel user agent and unsupported/resource/error monitoring; no skips. Use controls actually offered by each viewport.
4. Root runs the two focused mounted suites, both TypeScript checks and the new browser file on Chromium desktop/mobile and Firefox desktop. Capture the native prefilled form for inspection. Check production source/build isolation in the frozen final release sequence.
5. Commit exact owned files, then fresh scoped Astra review. Revisions remain bounded to findings. Update final review/verifier briefs to include the sixth browser file and require zero skips across all configured projects. Existing nine-command release gates, privacy checks, exact artifact hashing and authorized publication order remain binding.
