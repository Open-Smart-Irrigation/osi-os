import React from 'react';
import { IrrigationActionBanner } from 'open-smart-irrigation';

// Reasonings mirror the strings the daily analytics job writes to
// zone_recommendations.action_reasoning. History dots are the 7-day
// zone_stress_summary trail (oldest → newest).
const dayStr = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

const hist = (levels: string[]) =>
  levels.map((stress, i) => ({ date: dayStr(levels.length - 1 - i), stress }));

const col = { display: 'flex', flexDirection: 'column' as const, gap: 12, maxWidth: 640 };

// Steady state: maintain, with a calm 7-day stress trail.
export function Maintain() {
  return (
    <div style={col}>
      <IrrigationActionBanner
        action="maintain"
        reasoning="Zone TWDnorm 0.42 within target band; recovery ratio 91% — trees recover fully overnight."
        history={hist(['none', 'none', 'mild', 'none', 'none', 'mild', 'none'])}
      />
    </div>
  );
}

// Over-watered zone: both decrease steps.
export function DecreaseActions() {
  return (
    <div style={col}>
      <IrrigationActionBanner
        action="decrease_10"
        reasoning="Recovery ratio 97% for 5 consecutive days and TWDnorm 0.18 — mild over-irrigation likely."
      />
      <IrrigationActionBanner
        action="decrease_20"
        reasoning="Zone fully recovered for 7 days with 14.2 mm rain in the last 72 h; soil reserve is ample."
        history={hist(['mild', 'none', 'none', 'none', 'none', 'none', 'none'])}
      />
    </div>
  );
}

// Suppression / verification hold states.
export function HoldStates() {
  return (
    <div style={col}>
      <IrrigationActionBanner
        action="maintain_rain_suppression"
        reasoning="8.4 mm rain in the last 24 h and 12 mm forecast — holding irrigation changes until rain effect is measured."
      />
      <IrrigationActionBanner
        action="maintain_recovery_hold"
        reasoning="Irrigation was increased 2 days ago; verifying recovery ratio trend before further changes."
        history={hist(['moderate', 'moderate', 'significant', 'moderate', 'mild', 'mild', 'none'])}
      />
    </div>
  );
}

// Escalating deficit: both increase steps with a worsening trail.
export function IncreaseActions() {
  return (
    <div style={col}>
      <IrrigationActionBanner
        action="increase_10"
        reasoning="Zone TWDnorm 0.74 and rising for 3 days; recovery ratio dropped to 62%."
        history={hist(['none', 'none', 'mild', 'mild', 'mild', 'moderate', 'moderate'])}
      />
      <IrrigationActionBanner
        action="increase_20"
        reasoning="Mean TWDnorm 1.05, VPD max 3.1 kPa and no rain forecast in the next 72 h."
        history={hist(['mild', 'mild', 'moderate', 'moderate', 'significant', 'significant', 'significant'])}
      />
    </div>
  );
}

// Red-alert banner: emergency irrigation with a severe 7-day trail.
// (Caption also keeps the cell text from starting with the banner's ⚠ icon,
// which the capture's error heuristic would misread as a crash banner.)
export function Emergency() {
  return (
    <div style={col}>
      <p style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#64748b' }}>
        Orchard — Block C · today
      </p>
      <IrrigationActionBanner
        action="emergency_irrigate"
        reasoning="3 of 4 trees severe; zone TWDnorm 1.52 with recovery ratio 28% and no rain expected — irrigate immediately."
        history={hist(['moderate', 'moderate', 'significant', 'significant', 'severe', 'severe', 'severe'])}
      />
    </div>
  );
}
