// #378: a journal draft queued under one session must never be sent with the
// token of the session that replaced it. The queued write can run in the
// short window after the session changed and before React unmounted the old
// capture flow, so the hook binds its writes to the session it belongs to.
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../../AppProviders';
import {
  PrivateArea,
  createAuthHandle,
  flushMicrotasks,
  installFakeNetwork,
  loginAs,
  ok,
  resetSession,
  restoreNetwork,
  writeFromOtherTab,
  type FakeNetwork,
} from '../../contexts/__tests__/sessionHarness';
import type { CreateEntryPayload } from '../../services/journalApi';
import { useCaptureDraft, type UseCaptureDraftResult } from '../useCaptureDraft';

const ENTRIES = '/api/journal/entries';

let network: FakeNetwork;
let authHandle: ReturnType<typeof createAuthHandle>;
let capture: UseCaptureDraftResult | null = null;

function CaptureProbe() {
  capture = useCaptureDraft({ debounceMs: 60_000 });
  return null;
}

const draft = {
  plot_uuid: null,
  base_sync_version: 0,
  activity_code: 'observation',
  notes: 'alice private note',
} as unknown as CreateEntryPayload;

beforeEach(() => {
  resetSession();
  capture = null;
  network = installFakeNetwork();
  network.on('POST', ENTRIES, () => ok({ entry_uuid: 'e-1', sync_version: 1 }));
  authHandle = createAuthHandle();
});

afterEach(() => {
  restoreNetwork();
  localStorage.clear();
});

describe('useCaptureDraft session binding (#378)', () => {
  it('does not send a queued draft with the token of the session that replaced it', async () => {
    const { AuthCapture } = authHandle;
    render(
      <AppProviders>
        <AuthCapture />
        <PrivateArea>
          <CaptureProbe />
        </PrivateArea>
      </AppProviders>,
    );
    await loginAs(authHandle.auth, 'alice');
    await waitFor(() => expect(capture?.entryUuid).toBeTruthy());

    act(() => capture!.updateDraft(draft));

    await act(async () => {
      const queued = capture!;
      writeFromOtherTab('token-bob-77', 'bob');
      void queued.saveDraft().catch(() => undefined);
      await flushMicrotasks();
    });

    const sent = network.to('POST', ENTRIES);
    expect(sent.filter((request) => request.authorization === 'Bearer token-bob-77')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});
