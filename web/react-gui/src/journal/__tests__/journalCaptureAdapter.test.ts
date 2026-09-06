import { describe, expect, it } from 'vitest';

import {
  assertCaptureAdapterContract,
  type JournalCaptureAdapter,
} from '../journalCaptureAdapter';

type Scope = { plotUuid: string | null };
type Draft = { draftUuid: string };
type Intent = { entryUuid: string };
type Receipt = { receiptUuid: string };

function adapter(
  authority: JournalCaptureAdapter<Scope, Draft, Intent, Receipt>['authority'],
  capabilities: JournalCaptureAdapter<Scope, Draft, Intent, Receipt>['capabilities'],
): JournalCaptureAdapter<Scope, Draft, Intent, Receipt> {
  return {
    authority,
    capabilities,
    loadScope: async () => ({ kind: 'ready', value: { plotUuid: null } }),
    revalidateScope: async () => ({ kind: 'ready', value: { plotUuid: null } }),
    loadDrafts: async () => ({ kind: 'ready', value: [] }),
    saveDraft: async () => ({ kind: 'saved', draft: { draftUuid: 'draft-1' } }),
    discardDraft: async () => ({ kind: 'discarded' }),
    submit: async () => ({ kind: 'pending', receiptUuid: 'receipt-1' }),
    lookupReceipt: async () => ({ kind: 'unknown', receiptUuid: 'receipt-1' }),
  };
}

describe('JournalCaptureAdapter semantic authority contract', () => {
  it('accepts edge-local, gateway-backed cloud, and cloud-primary adapters', () => {
    expect(() => assertCaptureAdapterContract(adapter('edge_local', {
      canCreatePlots: true,
      supportsAttachments: true,
      draftStorage: 'edge_local',
      finalization: 'canonical_immediate',
    }))).not.toThrow();
    expect(() => assertCaptureAdapterContract(adapter('cloud_gateway', {
      canCreatePlots: false,
      supportsAttachments: false,
      draftStorage: 'cloud_working_copy',
      finalization: 'gateway_command',
    }))).not.toThrow();
    expect(() => assertCaptureAdapterContract(adapter('cloud_primary', {
      canCreatePlots: false,
      supportsAttachments: true,
      draftStorage: 'cloud_working_copy',
      finalization: 'canonical_immediate',
    }))).not.toThrow();
  });

  it('rejects authority-erasing capability combinations', () => {
    expect(() => assertCaptureAdapterContract(adapter('cloud_primary', {
      canCreatePlots: true,
      supportsAttachments: true,
      draftStorage: 'cloud_working_copy',
      finalization: 'canonical_immediate',
    }))).toThrow('cloud_primary cannot create edge-owned plots');
    expect(() => assertCaptureAdapterContract(adapter('cloud_gateway', {
      canCreatePlots: false,
      supportsAttachments: true,
      draftStorage: 'cloud_working_copy',
      finalization: 'gateway_command',
    }))).toThrow('cloud_gateway cannot enable attachments');
  });

  it('keeps a gateway command receipt pending or unknown until edge evidence arrives', async () => {
    const receipt = await adapter('cloud_gateway', {
      canCreatePlots: false,
      supportsAttachments: false,
      draftStorage: 'cloud_working_copy',
      finalization: 'gateway_command',
    }).lookupReceipt('receipt-1');
    expect(receipt.kind).not.toBe('confirmed');
  });
});
