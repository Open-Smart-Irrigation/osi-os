# Slice 3 — Downlink Confirmation UX (LSN50 mode + all sibling controls)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator unmissable feedback when a device-control button enqueues a downlink, and make it impossible to enqueue a duplicate command while one is already pending. The first integration closes `osi-server#27`. The same pattern then rolls out to every sibling control across DraginoCard, KiwiSensorCard, and StregaValveCard.

**Architecture:** One reusable React hook (`useDownlinkAction`) + two reusable components (`DownlinkConfirmModal`, `DownlinkPendingBadge`). The hook owns the lifecycle (`idle` → `submitting` → `pending` → `confirmed` | `failed`), the modal forces an explicit user acknowledgement after the cloud accepts the request, and the badge keeps the call site visibly "still pending" until the device's next uplink confirms the change. No backend changes. No new cross-cutting state libraries — the hook is a leaf primitive each card owns one instance of per action.

**Tech Stack:** React/Vite/TypeScript (osi-server frontend), Vitest, react-i18next, existing `api.put` / `api.post` HTTP client.

**Scope guard (CLAUDE.md "no premature abstraction"):**
- Only **button-driven downlink actions** are in scope. Toggle checkboxes have a different design question (optimistic update vs. spinner-overlay) and are NOT covered here.
- Backend idempotency ("don't enqueue if a same-type pending command already exists") is **out of scope**. The frontend already prevents duplicates after this change; cloud-side idempotency can be a follow-up issue with its own evidence.
- The hook is downlink-specific. Do NOT generalize to "any async action" — its lifecycle and confirmation semantics only make sense for fire-and-wait device control.

---

## Issue Coverage

| Issue | Scope |
|---|---|
| `osi-server#27` LSN50 mode change does not work from server device card | Closed by Phase 2 (canonical first integration). The backend works; the bug is silent feedback causing duplicate clicks. |

The same pattern transitively prevents the same UX bug on:
- DraginoCard: `applyMode`, `applyInterval`, `applyInterruptMode`, `applyFiveVoltWarmup` (4 actions)
- KiwiSensorCard: `setUplinkInterval`, `enableTemperatureHumidity` (2 actions)
- StregaValveCard: `setUplinkInterval`, `model`, `timed`, `magnet`, `partial`, `flush` (6 actions)

12 call sites total. No separate issues exist for the sibling cards yet — close `#27` with evidence and document the broader rollout in the PR description.

---

## Files Touched

**Created**
- `osi-server/frontend/src/hooks/useDownlinkAction.ts`
- `osi-server/frontend/src/hooks/__tests__/useDownlinkAction.test.tsx`
- `osi-server/frontend/src/components/farming/downlink/DownlinkConfirmModal.tsx`
- `osi-server/frontend/src/components/farming/downlink/DownlinkPendingBadge.tsx`
- `osi-server/frontend/src/components/farming/downlink/__tests__/DownlinkConfirmModal.test.tsx`
- `osi-server/frontend/src/components/farming/downlink/__tests__/DownlinkPendingBadge.test.tsx`
- `osi-server/frontend/src/components/farming/__tests__/DraginoCard.modeAction.test.tsx`

**Modified**
- `osi-server/frontend/src/components/farming/DraginoCard.tsx` (4 actions)
- `osi-server/frontend/src/components/farming/KiwiSensorCard.tsx` (2 actions)
- `osi-server/frontend/src/components/farming/StregaValveCard.tsx` (6 actions)
- `osi-server/frontend/public/locales/en/devices.json` (new i18n keys)
- `osi-server/frontend/public/locales/en/common.json` (modal OK / Close labels if missing)

---

## Common Prerequisites

- [ ] **Step 1: Confirm clean worktree on the slice branch**

```bash
cd /home/phil/Repos/osi-server/.worktrees/slice-3-lsn50-mode
git status --short --branch
git log --oneline main..HEAD
```

Expected: working tree clean; no commits yet on `feature/slice-3-lsn50-mode` (branch was created but never executed).

- [ ] **Step 2: Confirm Vitest is the test runner for `frontend/src`**

```bash
cd /home/phil/Repos/osi-server/frontend
grep -E '"test"|vitest|jest' package.json
```

Expected: scripts include `vitest run` and `vitest --ui`. **All new tests in this slice use Vitest** (`import { describe, test, expect, vi } from 'vitest'`), not `node:test`.

- [ ] **Step 3: Confirm the existing card files**

```bash
cd /home/phil/Repos/osi-server/frontend
wc -l src/components/farming/DraginoCard.tsx src/components/farming/KiwiSensorCard.tsx src/components/farming/StregaValveCard.tsx
```

Expected: three files exist. Note their line counts — large diffs in Task 5–8 should not be surprising relative to these.

---

## Phase 1 — Shared primitives (hook + modal + badge)

The primitives must land first and be independently testable before any card is migrated.

### Task 1.1: Define the lifecycle and write the hook test

- [ ] **Step 1: Failing test for the hook lifecycle**

Create `osi-server/frontend/src/hooks/__tests__/useDownlinkAction.test.tsx`:

```tsx
import { describe, test, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDownlinkAction } from '../useDownlinkAction';

const noop = () => {};

describe('useDownlinkAction', () => {
  test('starts in idle with no pending value', () => {
    const { result } = renderHook(() =>
      useDownlinkAction<string>({
        submit: vi.fn(),
        isConfirmed: () => false,
        labelFor: (v) => v,
      })
    );
    expect(result.current.status).toBe('idle');
    expect(result.current.pendingValue).toBeNull();
    expect(result.current.isModalOpen).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test('submit → submitting → pending opens the modal on success', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useDownlinkAction<'MOD5'>({
        submit,
        isConfirmed: () => false,
        labelFor: (v) => v,
      })
    );

    await act(async () => {
      await result.current.submit('MOD5');
    });

    expect(submit).toHaveBeenCalledWith('MOD5');
    expect(result.current.status).toBe('pending');
    expect(result.current.pendingValue).toBe('MOD5');
    expect(result.current.isModalOpen).toBe(true);
    expect(result.current.error).toBeNull();
  });

  test('a second submit while pending is rejected without calling submit again', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useDownlinkAction<'MOD5'>({
        submit,
        isConfirmed: () => false,
        labelFor: (v) => v,
      })
    );

    await act(async () => { await result.current.submit('MOD5'); });
    await act(async () => { await result.current.submit('MOD5'); });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('pending');
  });

  test('acknowledge closes the modal but keeps pending status', async () => {
    const { result } = renderHook(() =>
      useDownlinkAction<'MOD5'>({
        submit: vi.fn().mockResolvedValue(undefined),
        isConfirmed: () => false,
        labelFor: (v) => v,
      })
    );

    await act(async () => { await result.current.submit('MOD5'); });
    act(() => { result.current.acknowledge(); });

    expect(result.current.isModalOpen).toBe(false);
    expect(result.current.status).toBe('pending');
    expect(result.current.pendingValue).toBe('MOD5');
  });

  test('isConfirmed turning true transitions to confirmed and clears pending', async () => {
    let observed: 'MOD5' | 'MOD1' = 'MOD1';
    const { result, rerender } = renderHook(({ observedMode }) =>
      useDownlinkAction<'MOD5'>({
        submit: vi.fn().mockResolvedValue(undefined),
        isConfirmed: (requested) => observedMode === requested,
        labelFor: (v) => v,
        observationKey: observedMode,
      }), { initialProps: { observedMode: observed } }
    );

    await act(async () => { await result.current.submit('MOD5'); });
    expect(result.current.status).toBe('pending');

    observed = 'MOD5';
    rerender({ observedMode: 'MOD5' });

    await waitFor(() => expect(result.current.status).toBe('confirmed'));
    expect(result.current.pendingValue).toBeNull();
  });

  test('submit rejection moves to failed and surfaces the error message', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('Backend boom'));
    const { result } = renderHook(() =>
      useDownlinkAction<'MOD5'>({
        submit,
        isConfirmed: () => false,
        labelFor: (v) => v,
      })
    );

    await act(async () => {
      await result.current.submit('MOD5').catch(noop);
    });

    expect(result.current.status).toBe('failed');
    expect(result.current.error).toContain('Backend boom');
    expect(result.current.isModalOpen).toBe(false);
    expect(result.current.pendingValue).toBeNull();
  });

  test('reset returns the hook to idle and clears the value', async () => {
    const { result } = renderHook(() =>
      useDownlinkAction<'MOD5'>({
        submit: vi.fn().mockResolvedValue(undefined),
        isConfirmed: () => false,
        labelFor: (v) => v,
      })
    );

    await act(async () => { await result.current.submit('MOD5'); });
    act(() => { result.current.reset(); });

    expect(result.current.status).toBe('idle');
    expect(result.current.pendingValue).toBeNull();
    expect(result.current.isModalOpen).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/frontend
npm run test:unit -- useDownlinkAction
```

Expected: FAIL — `useDownlinkAction` module does not exist.

- [ ] **Step 2: Implement the hook**

Create `osi-server/frontend/src/hooks/useDownlinkAction.ts`:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type DownlinkStatus = 'idle' | 'submitting' | 'pending' | 'confirmed' | 'failed';

export interface UseDownlinkActionConfig<T> {
  /** Performs the actual HTTP call. Resolves on cloud accept (typically 202). */
  submit: (value: T) => Promise<void>;
  /** Returns true once the device's latest known state matches the requested value. */
  isConfirmed: (value: T) => boolean;
  /** Renders the value for display (e.g. mode → "MOD5", minutes → "20 min"). */
  labelFor: (value: T) => string;
  /**
   * Optional observation key that the hook depends on for re-evaluating
   * `isConfirmed`. Typically the same primitive the predicate compares
   * (e.g. the device's currently observed mode). React will re-run the
   * confirmation effect when this changes.
   */
  observationKey?: unknown;
}

export interface UseDownlinkActionResult<T> {
  status: DownlinkStatus;
  pendingValue: T | null;
  pendingLabel: string | null;
  isModalOpen: boolean;
  error: string | null;
  /** Called by the click handler; rejects the call without firing a duplicate request when already submitting/pending. */
  submit: (value: T) => Promise<void>;
  /** Dismisses the modal but leaves the pending state intact. */
  acknowledge: () => void;
  /** Forces back to idle (used by Retry buttons after a failure). */
  reset: () => void;
}

export function useDownlinkAction<T>(
  config: UseDownlinkActionConfig<T>
): UseDownlinkActionResult<T> {
  const [status, setStatus] = useState<DownlinkStatus>('idle');
  const [pendingValue, setPendingValue] = useState<T | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Capture latest predicate so the confirmation effect always reads the freshest closure.
  const isConfirmedRef = useRef(config.isConfirmed);
  isConfirmedRef.current = config.isConfirmed;

  const submit = useCallback(async (value: T) => {
    if (status === 'submitting' || status === 'pending') {
      // Block duplicate clicks while either the HTTP call is in flight
      // or the device confirmation is outstanding.
      return;
    }
    setStatus('submitting');
    setError(null);
    setPendingValue(value);
    try {
      await config.submit(value);
      setStatus('pending');
      setIsModalOpen(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus('failed');
      setPendingValue(null);
      setIsModalOpen(false);
      setError(message);
      throw e;
    }
  }, [config, status]);

  const acknowledge = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setPendingValue(null);
    setIsModalOpen(false);
    setError(null);
  }, []);

  // Confirmation watcher — runs whenever the caller's observationKey changes.
  useEffect(() => {
    if (status !== 'pending' || pendingValue === null) return;
    if (isConfirmedRef.current(pendingValue)) {
      setStatus('confirmed');
      setPendingValue(null);
    }
  }, [status, pendingValue, config.observationKey]);

  const pendingLabel = useMemo(
    () => (pendingValue === null ? null : config.labelFor(pendingValue)),
    [pendingValue, config]
  );

  return {
    status,
    pendingValue,
    pendingLabel,
    isModalOpen,
    error,
    submit,
    acknowledge,
    reset,
  };
}
```

Run the test:

```bash
npm run test:unit -- useDownlinkAction
```

Expected: PASS for all seven cases.

- [ ] **Step 3: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/slice-3-lsn50-mode
git add frontend/src/hooks/useDownlinkAction.ts frontend/src/hooks/__tests__/useDownlinkAction.test.tsx
git commit -m "feat(downlink): useDownlinkAction hook for fire-and-confirm device commands"
```

### Task 1.2: Build the confirmation modal

Reuse the visual shell from existing modals (`ClaimGatewayModal`, `AddDeviceModal`) — same Tailwind structure, same i18n namespaces.

- [ ] **Step 1: Failing test**

Create `osi-server/frontend/src/components/farming/downlink/__tests__/DownlinkConfirmModal.test.tsx`:

```tsx
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../../i18n/config';
import { DownlinkConfirmModal } from '../DownlinkConfirmModal';

const renderModal = (props: Partial<React.ComponentProps<typeof DownlinkConfirmModal>> = {}) =>
  render(
    <I18nextProvider i18n={i18n}>
      <DownlinkConfirmModal
        isOpen
        onAcknowledge={vi.fn()}
        title="Mode change queued"
        requestedLabel="MOD5"
        bodyText="The gateway has accepted the request. The device will apply MOD5 on its next uplink."
        {...props}
      />
    </I18nextProvider>
  );

describe('DownlinkConfirmModal', () => {
  test('renders the requested label prominently', () => {
    renderModal();
    expect(screen.getByText(/Mode change queued/)).toBeInTheDocument();
    expect(screen.getByText('MOD5')).toBeInTheDocument();
  });

  test('OK button calls onAcknowledge', async () => {
    const onAcknowledge = vi.fn();
    renderModal({ onAcknowledge });
    await userEvent.click(screen.getByRole('button', { name: /OK/i }));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  test('returns null when isOpen is false', () => {
    const { container } = renderModal({ isOpen: false });
    expect(container).toBeEmptyDOMElement();
  });
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/frontend
npm run test:unit -- DownlinkConfirmModal
```

Expected: FAIL — module missing.

- [ ] **Step 2: Implement the modal**

Create `osi-server/frontend/src/components/farming/downlink/DownlinkConfirmModal.tsx`:

```tsx
import React from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  isOpen: boolean;
  onAcknowledge: () => void;
  /** Heading shown at the top of the modal (already-translated string). */
  title: string;
  /** The exact value the user requested (e.g. 'MOD5', '20 min'). Rendered large/bold so it is unmissable. */
  requestedLabel: string;
  /** Sentence below the label explaining when confirmation will arrive. */
  bodyText: string;
}

export const DownlinkConfirmModal: React.FC<Props> = ({
  isOpen,
  onAcknowledge,
  title,
  requestedLabel,
  bodyText,
}) => {
  const { t: tc } = useTranslation('common');
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="downlink-confirm-title"
    >
      <div className="bg-[var(--surface)] border-2 border-[var(--border)] rounded-xl p-6 max-w-md w-full mx-4">
        <h2
          id="downlink-confirm-title"
          className="text-xl font-bold text-[var(--text)] mb-2"
        >
          {title}
        </h2>
        <div className="rounded-lg bg-[var(--card)] border border-[var(--border)] px-4 py-3 mt-3 mb-4">
          <div className="text-[var(--text-tertiary)] text-xs font-semibold uppercase tracking-wide">
            {tc('downlink.requestedValueLabel', { defaultValue: 'Requested value' })}
          </div>
          <div className="text-[var(--text)] text-2xl font-bold mt-1">
            {requestedLabel}
          </div>
        </div>
        <p className="text-[var(--text-secondary)] text-sm mb-5">{bodyText}</p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onAcknowledge}
            className="px-6 py-3 bg-[var(--primary)] text-white rounded-lg font-semibold hover:opacity-90"
          >
            {tc('ok', { defaultValue: 'OK' })}
          </button>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 3: Add i18n keys to `common.json`**

If `frontend/public/locales/en/common.json` does not already define `ok` and `downlink.requestedValueLabel`, add them. Verify with:

```bash
cd /home/phil/Repos/osi-server/frontend
grep -E '"ok"|requestedValueLabel' public/locales/en/common.json || echo "MISSING — add"
```

If missing, edit `public/locales/en/common.json` to add (preserve existing keys):

```json
"ok": "OK",
"downlink": {
  "requestedValueLabel": "Requested value"
}
```

Run the modal test. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/slice-3-lsn50-mode
git add frontend/src/components/farming/downlink/DownlinkConfirmModal.tsx \
        frontend/src/components/farming/downlink/__tests__/DownlinkConfirmModal.test.tsx \
        frontend/public/locales/en/common.json
git commit -m "feat(downlink): reusable confirmation modal for queued device commands"
```

### Task 1.3: Build the pending badge

A small, high-contrast inline indicator the card renders next to the action button to keep the "waiting for the device" state visible after the modal is dismissed.

- [ ] **Step 1: Failing test**

Create `osi-server/frontend/src/components/farming/downlink/__tests__/DownlinkPendingBadge.test.tsx`:

```tsx
import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../../i18n/config';
import { DownlinkPendingBadge } from '../DownlinkPendingBadge';

const renderBadge = (props: Partial<React.ComponentProps<typeof DownlinkPendingBadge>> = {}) =>
  render(
    <I18nextProvider i18n={i18n}>
      <DownlinkPendingBadge label="MOD5" {...props} />
    </I18nextProvider>
  );

describe('DownlinkPendingBadge', () => {
  test('renders the pending label', () => {
    renderBadge();
    expect(screen.getByText(/Pending/i)).toBeInTheDocument();
    expect(screen.getByText('MOD5')).toBeInTheDocument();
  });

  test('renders nothing when label is null', () => {
    const { container } = renderBadge({ label: null });
    expect(container).toBeEmptyDOMElement();
  });
});
```

Run:

```bash
npm run test:unit -- DownlinkPendingBadge
```

Expected: FAIL.

- [ ] **Step 2: Implement the badge**

Create `osi-server/frontend/src/components/farming/downlink/DownlinkPendingBadge.tsx`:

```tsx
import React from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  /** When null, the badge renders nothing — caller can wire it unconditionally. */
  label: string | null;
}

export const DownlinkPendingBadge: React.FC<Props> = ({ label }) => {
  const { t: tc } = useTranslation('common');
  if (!label) return null;
  return (
    <div className="mt-2 inline-flex items-center gap-2 rounded-md border border-[var(--warning, #f59e0b)] bg-[var(--warning-soft, #fef3c7)] px-3 py-1.5 text-xs font-semibold text-[var(--warning-text, #92400e)]">
      <span className="w-2 h-2 rounded-full bg-current animate-pulse" aria-hidden="true" />
      <span>
        {tc('downlink.pending', { defaultValue: 'Pending' })}
      </span>
      <span className="font-mono tracking-tight">{label}</span>
    </div>
  );
};
```

- [ ] **Step 3: Add the `downlink.pending` key to `common.json`**

```bash
grep '"pending"' frontend/public/locales/en/common.json || echo "add downlink.pending"
```

Add to `frontend/public/locales/en/common.json` under the `downlink` object:

```json
"downlink": {
  "requestedValueLabel": "Requested value",
  "pending": "Pending"
}
```

Run the badge test. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/farming/downlink/DownlinkPendingBadge.tsx \
        frontend/src/components/farming/downlink/__tests__/DownlinkPendingBadge.test.tsx \
        frontend/public/locales/en/common.json
git commit -m "feat(downlink): pending badge for visible waiting-for-uplink state"
```

---

## Phase 2 — DraginoCard `applyMode` (the canonical integration — closes `#27`)

This is the single integration that the issue is about. Land it as its own commit so reverting the rollout in Phase 3–4 leaves the fix for `#27` intact.

### Task 2.1: Live reproduction before the fix (evidence for the issue)

This step captures the bug exactly as it manifests in production so the issue can close with "before/after" evidence.

- [ ] **Step 1: Baseline count of LSN50 mode commands on kaba100**

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.93.68.86 \
  'sqlite3 /data/db/farming.db \
     "SELECT COUNT(*) AS total FROM applied_commands WHERE command_type='\''SET_LSN50_MODE'\'';"' \
  | tee /tmp/lsn50-mode-baseline.txt
```

Record the number. If SSH is blocked, document the blocker and skip — the unit test (Step 2 below) is sufficient to prove the duplicate-click bug.

- [ ] **Step 2: Open the LSN50 device card from the cloud dashboard for kaba100's LSN50 device and click "Apply mode" three times in 10 seconds**

Use a real browser. Wait 3 minutes for the edge to poll + the device to acknowledge.

- [ ] **Step 3: Confirm three new rows on kaba100**

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.93.68.86 \
  'sqlite3 -header -column /data/db/farming.db \
     "SELECT command_id, device_eui, result, applied_at FROM applied_commands \
      WHERE command_type='\''SET_LSN50_MODE'\'' \
      ORDER BY applied_at DESC LIMIT 5;"' \
  | tee /tmp/lsn50-mode-after-triple-click.txt
```

Expected: three new rows within ~30s of each other. The total count is baseline + 3. Attach this output to `osi-server#27` as the "before" evidence.

### Task 2.2: Migrate `applyMode` to the hook + modal + badge

- [ ] **Step 1: Failing integration test for the mode picker**

Create `osi-server/frontend/src/components/farming/__tests__/DraginoCard.modeAction.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../i18n/config';
import { DraginoCard } from '../DraginoCard';
import { lsn50API } from '../../../services/api';
import type { Device } from '../../../types/farming';

vi.mock('../../../services/api', () => ({
  lsn50API: {
    setMode: vi.fn(),
    setUplinkInterval: vi.fn(),
    setInterruptMode: vi.fn(),
    setFiveVoltWarmup: vi.fn(),
    setTempEnabled: vi.fn(),
    setDendroEnabled: vi.fn(),
    setRainGaugeEnabled: vi.fn(),
    setFlowMeterEnabled: vi.fn(),
  },
  devicesAPI: { /* unused by mode flow */ },
}));

const buildDevice = (overrides: Partial<Device> = {}): Device => ({
  deveui: 'A84041FFFF000099',
  deviceEui: 'A84041FFFF000099',
  type_id: 'DRAGINO_LSN50',
  name: 'LSN50 test',
  latest_data: { lsn50_mode_label: 'MOD1' },
  ...overrides,
} as Device);

const openCardWithModeOpen = async (device: Device, onUpdate = vi.fn()) => {
  render(
    <I18nextProvider i18n={i18n}>
      <DraginoCard device={device} onUpdate={onUpdate} />
    </I18nextProvider>
  );
  // Open the configuration panel.
  await userEvent.click(screen.getByRole('button', { name: /Configure|Settings/i }));
};

describe('DraginoCard mode action', () => {
  beforeEach(() => {
    vi.mocked(lsn50API.setMode).mockReset();
  });

  test('successful Apply opens the confirmation modal showing the requested mode', async () => {
    vi.mocked(lsn50API.setMode).mockResolvedValue(undefined);
    await openCardWithModeOpen(buildDevice());

    await userEvent.selectOptions(screen.getByLabelText(/Requested mode/i), 'MOD5');
    await userEvent.click(screen.getByRole('button', { name: /Apply mode/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByText('MOD5')).toBeInTheDocument();
    expect(lsn50API.setMode).toHaveBeenCalledTimes(1);
    expect(lsn50API.setMode).toHaveBeenCalledWith('A84041FFFF000099', 'MOD5');
  });

  test('button remains disabled and clicks are no-ops until device confirms', async () => {
    vi.mocked(lsn50API.setMode).mockResolvedValue(undefined);
    await openCardWithModeOpen(buildDevice());

    await userEvent.selectOptions(screen.getByLabelText(/Requested mode/i), 'MOD5');
    await userEvent.click(screen.getByRole('button', { name: /Apply mode/i }));
    await waitFor(() => screen.getByRole('dialog'));
    await userEvent.click(screen.getByRole('button', { name: /OK/i }));

    // Triple-click after dismissing the modal — must NOT enqueue more.
    const applyButton = screen.getByRole('button', { name: /Pending|Apply mode/i });
    await userEvent.click(applyButton);
    await userEvent.click(applyButton);
    await userEvent.click(applyButton);

    expect(lsn50API.setMode).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/MOD5/)).toBeInTheDocument();
  });

  test('failed Apply does not open the modal and surfaces the error', async () => {
    vi.mocked(lsn50API.setMode).mockRejectedValue(new Error('Network down'));
    await openCardWithModeOpen(buildDevice());

    await userEvent.selectOptions(screen.getByLabelText(/Requested mode/i), 'MOD5');
    await userEvent.click(screen.getByRole('button', { name: /Apply mode/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Failed/i)).toBeInTheDocument();
  });
});
```

Run:

```bash
npm run test:unit -- DraginoCard.modeAction
```

Expected: FAIL — the test mounts the existing component which does not yet use the hook/modal.

- [ ] **Step 2: Refactor `applyMode` to use the hook**

In `osi-server/frontend/src/components/farming/DraginoCard.tsx`:

1. Add imports at the top of the file:

```ts
import { useDownlinkAction } from '../../hooks/useDownlinkAction';
import { DownlinkConfirmModal } from './downlink/DownlinkConfirmModal';
import { DownlinkPendingBadge } from './downlink/DownlinkPendingBadge';
```

2. Inside `ConfigPanel`, replace the existing `selectedMode` / `pendingMode` / `modeInfo` state and the `applyMode` function. Keep `selectedMode` because the select is user-controlled, but remove `pendingMode` / `modeInfo` and the two `useEffect`s that watched them. The hook owns that lifecycle now.

Replace this block:

```ts
  const [selectedMode, setSelectedMode] = useState<Lsn50Mode>(getCurrentLsn50Mode(device) ?? 'MOD1');
  const [pendingMode, setPendingMode] = useState<Lsn50Mode | null>(null);
  const [modeInfo, setModeInfo] = useState<string | null>(null);
  // ... and the two related useEffects + the applyMode function
```

with:

```ts
  const [selectedMode, setSelectedMode] = useState<Lsn50Mode>(getCurrentLsn50Mode(device) ?? 'MOD1');

  const observedMode = device.latest_data?.lsn50_mode_label ?? null;

  const modeAction = useDownlinkAction<Lsn50Mode>({
    submit: async (mode) => {
      await lsn50API.setMode(device.deveui ?? device.deviceEui, mode);
      onUpdate(); // refresh parent so observedMode can update
    },
    isConfirmed: (requested) => getCurrentLsn50Mode(device) === requested,
    labelFor: (mode) => mode,
    observationKey: observedMode,
  });

  useEffect(() => {
    if (modeAction.status === 'idle' || modeAction.status === 'confirmed') {
      setSelectedMode(getCurrentLsn50Mode(device) ?? 'MOD1');
    }
  }, [device, modeAction.status]);

  const applyMode = async () => {
    if (selectedMode === currentMode && modeAction.status === 'idle') {
      // No-op: device already runs this mode and nothing is in flight.
      return;
    }
    if (
      selectedMode !== 'MOD1' && selectedMode !== 'MOD3' &&
      (device.dendro_enabled === 1 || device.temp_enabled === 1 || device.chameleon_enabled === 1) &&
      !window.confirm(t('draginoNode.modeChangeWarningConfirm', {
        defaultValue: 'Switching away from MOD1/MOD3 can change the telemetry OSI receives from this node. Continue?',
      }))
    ) {
      return;
    }
    setError(null);
    try {
      await modeAction.submit(selectedMode);
    } catch {
      setError(t('draginoNode.failedToUpdateMode', { defaultValue: 'Failed to change LSN50 mode' }));
    }
  };
```

3. Replace the Apply button block. Find:

```tsx
          <button
            type="button"
            onClick={applyMode}
            disabled={busy === 'mode'}
            className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === 'mode'
              ? t('draginoNode.applyingMode', { defaultValue: 'Applying mode...' })
              : t('draginoNode.applyMode', { defaultValue: 'Apply mode' })}
          </button>
          {modeInfo && <p className="text-[var(--text-tertiary)] text-xs mt-2">{modeInfo}</p>}
```

with:

```tsx
          <button
            type="button"
            onClick={applyMode}
            disabled={modeAction.status === 'submitting' || modeAction.status === 'pending'}
            className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {modeAction.status === 'submitting'
              ? t('draginoNode.applyingMode', { defaultValue: 'Sending request...' })
              : modeAction.status === 'pending'
              ? t('draginoNode.pendingMode', { defaultValue: 'Pending uplink — {{mode}}', mode: modeAction.pendingLabel ?? '' })
              : t('draginoNode.applyMode', { defaultValue: 'Apply mode' })}
          </button>
          <DownlinkPendingBadge label={modeAction.status === 'pending' ? modeAction.pendingLabel : null} />
          {modeAction.status === 'confirmed' && (
            <p className="text-[var(--success, #16a34a)] text-xs mt-2 font-semibold">
              {t('draginoNode.modeConfirmed', {
                defaultValue: 'Mode {{mode}} confirmed on the latest uplink.',
                mode: getCurrentLsn50Mode(device) ?? '',
              })}
            </p>
          )}
```

4. Mount the modal at the bottom of the `ConfigPanel` JSX (before the closing `</div>` of the panel root):

```tsx
        <DownlinkConfirmModal
          isOpen={modeAction.isModalOpen}
          onAcknowledge={modeAction.acknowledge}
          title={t('draginoNode.modeConfirmModalTitle', { defaultValue: 'Mode change queued' })}
          requestedLabel={modeAction.pendingLabel ?? ''}
          bodyText={t('draginoNode.modeConfirmModalBody', {
            defaultValue:
              'The gateway accepted the request. The device will apply the new mode on its next uplink window (typically within the device\'s configured uplink interval). The card updates automatically once confirmed.',
          })}
        />
```

5. Remove the now-dead `busy === 'mode'` branch from the select's `disabled` prop:

```tsx
          <select
            value={selectedMode}
            disabled={modeAction.status === 'submitting' || modeAction.status === 'pending'}
            onChange={(event) => setSelectedMode(event.target.value as Lsn50Mode)}
            ...
```

- [ ] **Step 3: Add the new i18n keys**

Edit `osi-server/frontend/public/locales/en/devices.json` to add (within the `draginoNode` object):

```json
"applyingMode": "Sending request...",
"pendingMode": "Pending uplink — {{mode}}",
"modeConfirmModalTitle": "Mode change queued",
"modeConfirmModalBody": "The gateway accepted the request. The device will apply the new mode on its next uplink window (typically within the device's configured uplink interval). The card updates automatically once confirmed."
```

(Replace the existing `applyingMode` value if present.)

- [ ] **Step 4: Run the integration test**

```bash
cd /home/phil/Repos/osi-server/frontend
npm run test:unit -- DraginoCard.modeAction
```

Expected: PASS for all three cases.

- [ ] **Step 5: Run the full frontend test suite to catch regressions**

```bash
npm run test:unit && npm run build
```

Expected: PASS. No type errors. Note: pre-existing failures unrelated to this change should not block the commit — capture them in the slice notes.

- [ ] **Step 6: Live verification after deploy (closes the loop on `#27`)**

Deploy the new frontend to staging (or wherever kaba100's cloud connects). Repeat Task 2.1 Steps 1–3 — triple-click "Apply mode" — but expect only ONE new row in `applied_commands`.

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.93.68.86 \
  'sqlite3 -header -column /data/db/farming.db \
     "SELECT command_id, device_eui, result, applied_at FROM applied_commands \
      WHERE command_type='\''SET_LSN50_MODE'\'' \
      ORDER BY applied_at DESC LIMIT 5;"' \
  | tee /tmp/lsn50-mode-after-fix.txt
```

Expected: one new row only. Attach this output to `osi-server#27` as the "after" evidence.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/slice-3-lsn50-mode
git add frontend/src/components/farming/DraginoCard.tsx \
        frontend/src/components/farming/__tests__/DraginoCard.modeAction.test.tsx \
        frontend/public/locales/en/devices.json
git commit -m "$(cat <<'EOF'
fix(devices): visible confirmation + pending state for LSN50 mode changes

Closes osi-server#27. The LSN50 mode-change flow worked end-to-end but
gave the operator no unmissable feedback after a successful enqueue,
causing them to click "Apply" multiple times. Each click queued a fresh
SET_LSN50_MODE pending command which the edge faithfully forwarded as a
duplicate LoRaWAN downlink.

This change wires the mode picker to the new useDownlinkAction hook +
DownlinkConfirmModal + DownlinkPendingBadge. After a successful enqueue,
a modal forces the operator to acknowledge; the button then remains
disabled with a pending-state label until the device's next uplink
confirms the new mode.
EOF
)"
```

---

## Phase 3 — Roll out to remaining DraginoCard button-actions

Same pattern, separately committed so a bug in one rollout does not force reverting the others. Each task is one button-action.

### Task 3.1: `applyInterval` (uplink interval in minutes)

- [ ] **Step 1: Add a hook instance**

In `DraginoCard.tsx`, alongside `modeAction`:

```ts
  const intervalAction = useDownlinkAction<number>({
    submit: async (minutes) => {
      await lsn50API.setUplinkInterval(device.deveui ?? device.deviceEui, minutes);
      onUpdate();
    },
    isConfirmed: (requested) => {
      const observed = Number(device.latest_data?.lsn50_uplink_interval_minutes);
      return Number.isFinite(observed) && observed === requested;
    },
    labelFor: (minutes) => `${minutes} min`,
    observationKey: device.latest_data?.lsn50_uplink_interval_minutes,
  });
```

If the device payload doesn't actually expose `lsn50_uplink_interval_minutes`, default `isConfirmed` to `() => false` and rely on the operator-driven `reset()` (next paragraph). Confirm by grepping `device.latest_data`:

```bash
grep -nE 'latest_data\?.lsn50' frontend/src/types/farming.ts frontend/src/components/farming/DraginoCard.tsx | head
```

If no observable confirmation field exists, the `pending` state can only be exited by the user clicking a fresh action OR via a soft auto-reset after, say, 10 minutes. Add a small useEffect:

```ts
  useEffect(() => {
    if (intervalAction.status !== 'pending') return;
    const timer = setTimeout(() => intervalAction.reset(), 10 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [intervalAction.status, intervalAction]);
```

This is acceptable because uplink-interval changes lack a verifiable feedback channel from the device — the badge stays for 10 min as a "command sent" hint, then clears.

- [ ] **Step 2: Replace the existing `applyInterval` function**

Replace this block:

```ts
  const applyInterval = async () => {
    // ... existing validation ...
    setBusy('interval');
    setError(null);
    setIntervalInfo(null);
    try {
      await lsn50API.setUplinkInterval(deveui, parsed);
      setIntervalMinutesInput(String(parsed));
      setIntervalInfo(t('draginoNode.intervalPending', { ... }));
      onUpdate();
    } catch {
      setError(t('draginoNode.failedToUpdateInterval', { ... }));
    } finally {
      setBusy(null);
    }
  };
```

with:

```ts
  const applyInterval = async () => {
    const parsed = Number(intervalMinutesInput);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LSN50_INTERVAL_MINUTES) {
      setError(t('draginoNode.invalidInterval', {
        defaultValue: 'Enter a whole number of minutes between 1 and {{max}}.',
        max: MAX_LSN50_INTERVAL_MINUTES,
      }));
      return;
    }
    setError(null);
    try {
      await intervalAction.submit(parsed);
      setIntervalMinutesInput(String(parsed));
    } catch {
      setError(t('draginoNode.failedToUpdateInterval', { defaultValue: 'Failed to change LSN50 uplink interval' }));
    }
  };
```

Also delete the now-unused `intervalInfo` state.

- [ ] **Step 3: Replace the interval button + add modal/badge**

Find the interval Apply button and replace with the same pattern used for mode:

```tsx
          <button
            type="button"
            onClick={applyInterval}
            disabled={intervalAction.status === 'submitting' || intervalAction.status === 'pending'}
            className="... existing classes ..."
          >
            {intervalAction.status === 'submitting'
              ? t('draginoNode.applyingInterval', { defaultValue: 'Sending request...' })
              : intervalAction.status === 'pending'
              ? t('draginoNode.pendingInterval', { defaultValue: 'Pending uplink — {{value}}', value: intervalAction.pendingLabel ?? '' })
              : t('draginoNode.applyInterval', { defaultValue: 'Apply interval' })}
          </button>
          <DownlinkPendingBadge label={intervalAction.status === 'pending' ? intervalAction.pendingLabel : null} />
```

Mount a second modal instance below the existing mode modal:

```tsx
        <DownlinkConfirmModal
          isOpen={intervalAction.isModalOpen}
          onAcknowledge={intervalAction.acknowledge}
          title={t('draginoNode.intervalConfirmModalTitle', { defaultValue: 'Uplink interval queued' })}
          requestedLabel={intervalAction.pendingLabel ?? ''}
          bodyText={t('draginoNode.intervalConfirmModalBody', {
            defaultValue:
              'The gateway accepted the request. The device will apply the new uplink interval on its next downlink window.',
          })}
        />
```

- [ ] **Step 4: Add i18n keys to `devices.json`**

```json
"applyingInterval": "Sending request...",
"pendingInterval": "Pending uplink — {{value}}",
"intervalConfirmModalTitle": "Uplink interval queued",
"intervalConfirmModalBody": "The gateway accepted the request. The device will apply the new uplink interval on its next downlink window."
```

- [ ] **Step 5: Verify**

```bash
npm run test:unit -- DraginoCard && npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/farming/DraginoCard.tsx frontend/public/locales/en/devices.json
git commit -m "fix(devices): downlink confirmation UX for LSN50 uplink interval"
```

### Task 3.2: `applyInterruptMode`

Same shape as Task 3.1. Hook config:

```ts
  const interruptAction = useDownlinkAction<number>({
    submit: async (mode) => {
      await lsn50API.setInterruptMode(device.deveui ?? device.deviceEui, mode);
      onUpdate();
    },
    isConfirmed: () => false, // no observable confirmation field
    labelFor: (mode) => String(mode),
    observationKey: null,
  });
  useEffect(() => {
    if (interruptAction.status !== 'pending') return;
    const timer = setTimeout(() => interruptAction.reset(), 10 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [interruptAction.status, interruptAction]);
```

i18n keys: `pendingInterrupt`, `interruptConfirmModalTitle`, `interruptConfirmModalBody`. Modal body: "The gateway accepted the request. The device will apply the new interrupt mode on its next downlink window."

Commit message: `fix(devices): downlink confirmation UX for LSN50 interrupt mode`.

### Task 3.3: `applyFiveVoltWarmup`

Same shape. Hook config:

```ts
  const warmupAction = useDownlinkAction<number>({
    submit: async (ms) => {
      await lsn50API.setFiveVoltWarmup(device.deveui ?? device.deviceEui, ms);
      onUpdate();
    },
    isConfirmed: () => false,
    labelFor: (ms) => `${ms} ms`,
    observationKey: null,
  });
  useEffect(() => {
    if (warmupAction.status !== 'pending') return;
    const timer = setTimeout(() => warmupAction.reset(), 10 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [warmupAction.status, warmupAction]);
```

i18n keys: `pendingWarmup`, `warmupConfirmModalTitle`, `warmupConfirmModalBody`.

Commit message: `fix(devices): downlink confirmation UX for LSN50 5V warmup`.

---

## Phase 4 — KiwiSensorCard

### Task 4.1: `kiwiAPI.setUplinkInterval`

In `KiwiSensorCard.tsx`:

```ts
import { useDownlinkAction } from '../../hooks/useDownlinkAction';
import { DownlinkConfirmModal } from './downlink/DownlinkConfirmModal';
import { DownlinkPendingBadge } from './downlink/DownlinkPendingBadge';

  const intervalAction = useDownlinkAction<number>({
    submit: async (minutes) => {
      await kiwiAPI.setUplinkInterval(device.deveui ?? device.deviceEui, minutes);
      onUpdate();
    },
    isConfirmed: (requested) => {
      const observed = Number(device.latest_data?.kiwi_uplink_interval_minutes);
      return Number.isFinite(observed) && observed === requested;
    },
    labelFor: (minutes) => `${minutes} min`,
    observationKey: device.latest_data?.kiwi_uplink_interval_minutes,
  });
```

If `kiwi_uplink_interval_minutes` does not exist on `latest_data`, use the `isConfirmed: () => false` + 10-minute auto-reset pattern from Task 3.1.

Replace the existing interval Apply button with the same pattern. Add the same modal mount. Add i18n keys under a `kiwiNode` object in `devices.json`:

```json
"applyingInterval": "Sending request...",
"pendingInterval": "Pending uplink — {{value}}",
"intervalConfirmModalTitle": "Uplink interval queued",
"intervalConfirmModalBody": "The gateway accepted the request. The KIWI device will apply the new uplink interval on its next downlink window."
```

Verify and commit: `fix(devices): downlink confirmation UX for KIWI uplink interval`.

### Task 4.2: `kiwiAPI.enableTemperatureHumidity`

Hook:

```ts
  const enableAction = useDownlinkAction<number>({
    submit: async (minutes) => {
      await kiwiAPI.enableTemperatureHumidity(device.deveui ?? device.deviceEui, minutes);
      onUpdate();
    },
    isConfirmed: () => false,
    labelFor: (minutes) => `${minutes} min`,
    observationKey: null,
  });
  useEffect(() => {
    if (enableAction.status !== 'pending') return;
    const timer = setTimeout(() => enableAction.reset(), 10 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [enableAction.status, enableAction]);
```

i18n keys: `pendingEnable`, `enableConfirmModalTitle`, `enableConfirmModalBody`.

Commit: `fix(devices): downlink confirmation UX for KIWI temperature/humidity enable`.

---

## Phase 5 — StregaValveCard

Six button-actions. Each gets its own commit. The pattern is identical to Phase 3/4. Hook config templates per action:

### Task 5.1: `setUplinkInterval`

```ts
  const intervalAction = useDownlinkAction<{ minutes?: number; closedMinutes?: number; openedMinutes?: number }>({
    submit: async (payload) => {
      await stregaAPI.setUplinkInterval(device.deveui ?? device.deviceEui, payload);
      onUpdate();
    },
    isConfirmed: () => false, // no observable confirmation today
    labelFor: (p) => {
      const parts: string[] = [];
      if (p.closedMinutes != null) parts.push(`closed ${p.closedMinutes}m`);
      if (p.openedMinutes != null) parts.push(`open ${p.openedMinutes}m`);
      if (p.minutes != null && parts.length === 0) parts.push(`${p.minutes}m`);
      return parts.join(', ');
    },
    observationKey: null,
  });
  useEffect(() => {
    if (intervalAction.status !== 'pending') return;
    const timer = setTimeout(() => intervalAction.reset(), 10 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [intervalAction.status, intervalAction]);
```

Commit: `fix(devices): downlink confirmation UX for STREGA uplink interval`.

### Task 5.2: `timed` (timed open)

```ts
  const timedAction = useDownlinkAction<number>({
    submit: async (minutes) => {
      await devicesAPI.controlValve(device.deveui ?? device.deviceEui, { action: 'timed_open', minutes });
      onUpdate();
    },
    isConfirmed: () => {
      // STREGA reports valve state on every uplink. A timed_open is confirmed when valve_state transitions to 'open'.
      return device.latest_data?.valve_state === 'open';
    },
    labelFor: (minutes) => `Open ${minutes} min`,
    observationKey: device.latest_data?.valve_state,
  });
```

Commit: `fix(devices): downlink confirmation UX for STREGA timed open`.

### Task 5.3: `magnet`, Task 5.4: `partial`, Task 5.5: `flush`, Task 5.6: `model`

Repeat the same pattern. For `magnet` (open/close via magnet) and `partial` (partial open), use `valve_state` as the confirmation anchor. For `flush`, no observable confirmation exists — use `isConfirmed: () => false` + 10-minute auto-reset. For `model` (the STREGA model selector), use the model field on `latest_data` if present, else fall back to auto-reset.

Each subtask is one commit: `fix(devices): downlink confirmation UX for STREGA <action>`.

---

## Phase 6 — Final verification and PR

### Task 6.1: Run the full frontend suite

```bash
cd /home/phil/Repos/osi-server/frontend
npm run test:unit
npm run build
```

Expected: every command exits 0.

### Task 6.2: Capture before/after evidence on `#27`

Attach `/tmp/lsn50-mode-baseline.txt`, `/tmp/lsn50-mode-after-triple-click.txt`, and `/tmp/lsn50-mode-after-fix.txt` to `osi-server#27`. Comment template:

```text
> *This was generated by AI during implementation verification.*

**Before (Task 2.1):** triple-click on "Apply mode" enqueued 3 duplicate `SET_LSN50_MODE` commands on kaba100. See `lsn50-mode-after-triple-click.txt`.

**After (Task 2.2 Step 6):** triple-click enqueues exactly 1 command and the operator sees a modal + persistent badge confirming the request. See `lsn50-mode-after-fix.txt`.

**Commits:**
- osi-server: <SHA(s)>

**Residual:**
- Sibling controls on the same card and on KiwiSensorCard/StregaValveCard received the same treatment (Phase 3–5). No separate issues opened — see PR description.
```

### Task 6.3: Open the PR

```bash
cd /home/phil/Repos/osi-server
gh pr create --base main --head feature/slice-3-lsn50-mode \
  --title "fix(devices): visible downlink confirmation + duplicate-click guard" \
  --body "$(cat <<'EOF'
## Summary
- Closes osi-server#27 (LSN50 mode change appears not to work because there is no visible confirmation).
- Adds a reusable `useDownlinkAction` hook + `DownlinkConfirmModal` + `DownlinkPendingBadge` for any device-control button that fires a downlink and waits for the next uplink to confirm.
- Rolls the pattern out to 12 button-actions across DraginoCard, KiwiSensorCard, and StregaValveCard.

## Test plan
- [x] Vitest: `useDownlinkAction` (7 lifecycle cases), modal + badge, DraginoCard mode integration (3 cases including duplicate-click guard).
- [x] `npm run build` clean.
- [x] Live: kaba100 SET_LSN50_MODE count rises by exactly 1 on triple-click after fix (was 3 before).
EOF
)"
```

---

## Execution Order

1. Phase 1 — primitives (3 commits)
2. Phase 2 — DraginoCard `applyMode` (1 commit) → closes `#27`
3. Phase 3 — DraginoCard interval / interrupt / warmup (3 commits)
4. Phase 4 — KiwiSensorCard interval / enable (2 commits)
5. Phase 5 — StregaValveCard interval / timed / magnet / partial / flush / model (6 commits)
6. Phase 6 — verification + PR

Each phase is independently mergeable. If Phase 5 reveals an issue with STREGA, Phases 1–4 still land cleanly. The two new directories (`src/hooks/`, `src/components/farming/downlink/`) are touched only in Phase 1; everything after is integration only.
