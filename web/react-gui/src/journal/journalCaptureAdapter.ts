export type JournalCaptureAuthority = 'edge_local' | 'cloud_gateway' | 'cloud_primary';

export interface JournalCaptureCapabilities {
  canCreatePlots: boolean;
  supportsAttachments: boolean;
  draftStorage: 'edge_local' | 'cloud_working_copy';
  finalization: 'canonical_immediate' | 'gateway_command';
}

export type JournalCaptureLoad<T> =
  | { kind: 'ready'; value: T }
  | { kind: 'partial'; value: T; failures: readonly JournalCaptureFailure[] }
  | { kind: 'stale_scope'; scope: string }
  | { kind: 'unavailable'; capability: string }
  | { kind: 'error'; failure: JournalCaptureFailure };

export interface JournalCaptureFailure {
  code: 'network' | 'validation' | 'forbidden' | 'not_found' | 'unavailable';
  retryable: boolean;
  message: string;
}

export type JournalCaptureDraftResult<Draft> =
  | { kind: 'saved'; draft: Draft }
  | { kind: 'rejected'; failure: JournalCaptureFailure };

export type JournalCaptureDiscardResult =
  | { kind: 'discarded' }
  | { kind: 'rejected'; failure: JournalCaptureFailure };

export type JournalCaptureReceipt<Receipt> =
  | { kind: 'pending'; receiptUuid: string }
  | { kind: 'confirmed'; receipt: Receipt }
  | { kind: 'rejected'; receiptUuid: string; failure: JournalCaptureFailure }
  | { kind: 'unknown'; receiptUuid: string };

export interface JournalCaptureAdapter<Scope, Draft, Intent, Receipt> {
  authority: JournalCaptureAuthority;
  capabilities: JournalCaptureCapabilities;
  loadScope(scope: Scope): Promise<JournalCaptureLoad<Scope>>;
  revalidateScope(scope: Scope): Promise<JournalCaptureLoad<Scope>>;
  loadDrafts(): Promise<JournalCaptureLoad<readonly Draft[]>>;
  saveDraft(draft: Draft): Promise<JournalCaptureDraftResult<Draft>>;
  discardDraft(draft: Draft): Promise<JournalCaptureDiscardResult>;
  submit(intent: Intent): Promise<JournalCaptureReceipt<Receipt>>;
  lookupReceipt(receiptUuid: string): Promise<JournalCaptureReceipt<Receipt>>;
}

type EdgeLocalFinalizationAdapter = JournalCaptureAdapter<
  null,
  never,
  CreateFinalBatchPayload,
  BatchMutationReceipt
>;

/**
 * The local gateway owns final journal writes.  This adapter is deliberately
 * narrow while the existing capture flow still owns its local draft state:
 * it moves the canonical final-write boundary behind the shared adapter
 * contract without pretending that a queued cloud command is equivalent.
 */
export function createEdgeLocalJournalCaptureAdapter(): EdgeLocalFinalizationAdapter {
  const unsupportedDraftFailure: JournalCaptureFailure = {
    code: 'unavailable',
    retryable: false,
    message: 'Edge drafts are managed by the local capture draft store',
  };
  return {
    authority: 'edge_local',
    capabilities: {
      canCreatePlots: true,
      supportsAttachments: true,
      draftStorage: 'edge_local',
      finalization: 'canonical_immediate',
    },
    loadScope: async (scope) => ({ kind: 'ready', value: scope }),
    revalidateScope: async (scope) => ({ kind: 'ready', value: scope }),
    loadDrafts: async () => ({ kind: 'error', failure: unsupportedDraftFailure }),
    saveDraft: async () => ({ kind: 'rejected', failure: unsupportedDraftFailure }),
    discardDraft: async () => ({ kind: 'rejected', failure: unsupportedDraftFailure }),
    submit: async (intent) => ({
      kind: 'confirmed',
      receipt: await journalApi.createFinalBatch(intent),
    }),
    lookupReceipt: async (receiptUuid) => ({ kind: 'unknown', receiptUuid }),
  };
}

/**
 * Defends the authority distinctions at the capture boundary. A gateway
 * command receipt is intentionally not canonical until its adapter returns
 * `confirmed` evidence.
 */
export function assertCaptureAdapterContract(
  adapter: Pick<JournalCaptureAdapter<never, never, never, never>, 'authority' | 'capabilities'>,
): void {
  const { authority, capabilities } = adapter;
  if (authority === 'cloud_primary' && capabilities.canCreatePlots) {
    throw new TypeError('cloud_primary cannot create edge-owned plots');
  }
  if (authority === 'cloud_gateway') {
    if (capabilities.canCreatePlots) {
      throw new TypeError('cloud_gateway cannot create edge-owned plots');
    }
    if (capabilities.supportsAttachments) {
      throw new TypeError('cloud_gateway cannot enable attachments');
    }
    if (capabilities.finalization !== 'gateway_command') {
      throw new TypeError('cloud_gateway finalization must remain a gateway command');
    }
  }
  if (authority === 'edge_local' && capabilities.draftStorage !== 'edge_local') {
    throw new TypeError('edge_local drafts must remain local');
  }
  if (authority !== 'edge_local' && capabilities.draftStorage !== 'cloud_working_copy') {
    throw new TypeError('cloud capture drafts must use cloud working copies');
  }
}
import { journalApi } from '../services/journalApi';
import type { BatchMutationReceipt, CreateFinalBatchPayload } from '../types/journal';

