import React from 'react';
import { ValveCancelButton } from 'open-smart-irrigation';

// Small action button rendered inside StregaValveCard while an open command
// is queued or running. Static idle render; the busy/error states only exist
// mid-request. Shown bare and in its real card context.
const device = {
  deveui: '70B3D5E75E0163B1',
  name: 'Valve — Motorized Main',
  type_id: 'STREGA_VALVE',
  current_state: 'CLOSED',
  target_state: 'OPEN',
  latest_data: {},
} as any;

export function Default() {
  return <ValveCancelButton device={device} onUpdate={() => {}} />;
}

// How it sits in the valve card: right-hand column of the action grid,
// bottom-aligned beside the open-duration control.
export function InValveCardContext() {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '12px 16px',
        maxWidth: 380,
      }}
    >
      <div style={{ color: 'var(--text-secondary)', fontSize: 13, paddingBottom: 8 }}>
        Valve — Motorized Main · open queued
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Duration (min)</label>
          <input
            type="number"
            defaultValue={10}
            readOnly
            style={{
              width: '100%',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--text)',
              borderRadius: 8,
              padding: '8px 12px',
              fontSize: 14,
            }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <ValveCancelButton device={device} onUpdate={() => {}} />
        </div>
      </div>
    </div>
  );
}
