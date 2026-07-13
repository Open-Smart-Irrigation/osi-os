import React from 'react';
import { StressBadge } from 'open-smart-irrigation';

// All six stress levels — the primary variant axis of the badge.
export function Levels() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <StressBadge level="none" />
      <StressBadge level="mild" />
      <StressBadge level="moderate" />
      <StressBadge level="significant" />
      <StressBadge level="severe" />
      <StressBadge level="unknown" />
    </div>
  );
}

export function SmallSize() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <StressBadge level="none" size="sm" />
      <StressBadge level="moderate" size="sm" />
      <StressBadge level="severe" size="sm" />
    </div>
  );
}
