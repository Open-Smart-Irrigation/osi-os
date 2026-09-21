import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ValveSummary } from '../../../types/farming';
import { deriveValveGlyphState } from './valveState';
import { ValveGlyph, valveGlyphLabel, type Translate } from './ValveGlyph';
import { describeLastSeen, renderLastSeen } from './valveCardHelpers';
import { getBatteryPercentFromVoltage, getValidBatteryPercent } from '../shared/deviceCardBattery';
import { useDismissOnPointerDown } from '../../../hooks/useDismissOnPointerDown';
import { formatTime } from '../../../utils/datetime';
import { EditableName } from '../shared/EditableName';

// Task 14 lands the `rename.*` keys in public/locales/*/devices.json; until
// then they're absent from en_devices and react-i18next's typed t() overload
// rejects them at compile time. Same drift, same fix as EditableName.tsx
// documents in full: a compile-time-only cast, no runtime defaultValue,
// removed once Task 14 lands the keys.
type TranslationKey = any;

export interface ValveTileProps {
  valve: ValveSummary;
  nowMs: number;
  onOpen: () => void;
  onSchedule: () => void;
  onCancel: () => void;
  onSkipToday: () => void;
  onPause: () => void;
  onResume: () => void;
  onResend: () => void;
  onSettings: () => void;
  // Low-prominence entry point to ValveServiceDialog (the six advanced STREGA commands).
  // Per the E1 ruling, this dialog has no independent entry point of its own -- it is
  // reachable only from here, inside the overflow menu, not as a primary button.
  onService: () => void;
  // Deliberately NOT placed next to the primary Open button -- see #171: the legacy
  // StregaValveCard put its remove control beside a one-tap water-moving action. This
  // lives inside the overflow menu instead, with its own confirmation step.
  onDelete: () => void;
  /** True when the caller's role may mutate; false hides the rename pencil. */
  canEdit: boolean;
  /** Renames the valve's device. Rejects so EditableName can show the reason. */
  onRename: (name: string) => Promise<void>;
  busy: boolean;
  // I6: battery footer line, ported from the OSI Server cloud's ValveTile.tsx. `ValveSummary`
  // (GET /api/valves) carries no battery field -- only `Device.latest_data` does -- so the
  // caller (ValveControlPanel, fed by FarmingDashboard's `batteryByEui`, built from the
  // device list it already polls) passes both raw fields through. `batteryVoltage` is an
  // edge-only addition over the cloud's prop (LSN50-style devices sometimes report only
  // `bat_v`, never `bat_pct`) -- see deviceCardBattery.ts. Loose-typed (`unknown`) to match
  // those helpers: a raw sensor value is never assumed clean.
  batteryPercent?: unknown;
  batteryVoltage?: unknown;
}

function formatRelativePast(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const deltaSec = Math.max(0, (nowMs - then) / 1000);
  if (deltaSec < 60) return `${Math.round(deltaSec)}s`;
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)} min`;
  if (deltaSec < 86400) return `${Math.round(deltaSec / 3600)} h`;
  return `${Math.round(deltaSec / 86400)} d`;
}

const Spinner: React.FC = () => (
  <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
);

export const ValveTile: React.FC<ValveTileProps> = ({
  valve,
  nowMs,
  onOpen,
  onSchedule,
  onCancel,
  onSkipToday,
  onPause,
  onResume,
  onResend,
  onSettings,
  onService,
  onDelete,
  canEdit,
  onRename,
  busy,
  batteryPercent,
  batteryVoltage,
}) => {
  const { t, i18n } = useTranslation('valves');
  const { t: tDevices } = useTranslation('devices');
  // `utils/datetime` resolves the locale from the app language and already
  // handles the unsupported-tag fallback for `lg`; the local helper this
  // replaces passed `undefined`, which is the operating system's locale.
  const clock = (iso: string) => formatTime(iso, i18n?.language, { timeZone: valve.timezone }) ?? '—';
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissOnPointerDown(menuRef, () => setMenuOpen(false));

  // I6: top-right, subtle -- shared by every ValveTile placement automatically since it is
  // derived straight from `valve.lastUplinkAt`, not a caller-supplied prop.
  const lastSeenLabel = renderLastSeen(describeLastSeen(valve.lastUplinkAt), t as Translate);
  const battery = getValidBatteryPercent(batteryPercent) ?? getBatteryPercentFromVoltage(batteryVoltage);

  const glyph = deriveValveGlyphState(valve, nowMs);
  const isPendingCommand = valve.activeActuation?.reconciliationState === 'PENDING_OBSERVATION';
  // #171 item 2: a valve that has never reported must not render as "closed and fine".
  // Only overrides the label when the glyph would otherwise resolve to a plain "closed" --
  // an active/pending actuation already carries its own honest label regardless of uplink history.
  const neverSeen = valve.lastUplinkAt === null && glyph.state === 'closed';
  const stateLabel = neverSeen ? t('neverSeen') : valveGlyphLabel(glyph.state, t as Translate);

  const statusDetails: string[] = [];
  if (glyph.state === 'open' && glyph.remainingSeconds !== null) {
    statusDetails.push(t('remaining', { minutes: Math.max(0, Math.ceil(glyph.remainingSeconds / 60)) }));
    if (glyph.closesAt) statusDetails.push(t('closesAt', { time: clock(glyph.closesAt) }));
  }
  if (glyph.state === 'pending') {
    // #171 item 3: a commanded-but-unconfirmed open says so, matching the honesty
    // StregaValveCard's actuationFeedback badge already has.
    statusDetails.push(t('pendingHint'));
    if (glyph.closesAt) statusDetails.push(t('closesAt', { time: clock(glyph.closesAt) }));
    if (valve.lastUplinkAt) {
      statusDetails.push(t('lastContact', { when: formatRelativePast(valve.lastUplinkAt, nowMs) }));
    }
  }

  let nextRunLine: string;
  if (valve.schedulerStatus === 'DEACTIVATED') {
    nextRunLine = t('schedulerPaused');
  } else if (valve.schedulerStatus === 'SKIP_TODAY') {
    nextRunLine = t('skippedToday');
  } else if (!valve.nextRun) {
    nextRunLine = t('noSchedule');
  } else {
    const when = clock(valve.nextRun.at);
    nextRunLine = valve.nextRun.kind === 'ONCE'
      ? t('nextRunOnce', { when, minutes: valve.nextRun.minutes })
      : t('nextRun', { when, minutes: valve.nextRun.minutes });
  }

  // `box_temp`/`box_hum` from inside the buried STREGA housing, which land in
  // the same `device_data.ambient_temperature` column the weather station
  // writes. Unlabelled on the tile — and the tile is where it is read — it
  // passes for zone air temperature; rising humidity in that box is water
  // ingress, a maintenance signal, not a growing condition.
  const climatePair =
    valve.stregaGeneration === 'GEN2' ? null
    : valve.enclosureTemperatureC == null && valve.enclosureHumidityPct == null ? null
    : [
        t('enclosure', { defaultValue: 'Valve enclosure' }),
        [
          valve.enclosureTemperatureC != null ? t('format.temperature', { value: valve.enclosureTemperatureC }) : null,
          valve.enclosureHumidityPct != null ? t('format.humidity', { value: valve.enclosureHumidityPct }) : null,
        ].filter(Boolean).join(' · '),
      ].join(' ');

  // Shown only when part of the plan genuinely did not reach the valve, and phrased as the
  // consequence the farmer can act on rather than as transport bookkeeping. Deliberately not
  // an alarm: see deriveValveGlyphState.
  const planLine: string | null =
    valve.pushState.failed > 0 ? t('planIncomplete', { count: valve.pushState.failed }) : null;

  const isPaused = valve.schedulerStatus === 'DEACTIVATED';
  const alreadySkipped = valve.schedulerStatus === 'SKIP_TODAY';

  // M-2 (final fix wave review): a queued-but-unconfirmed open is cancelled by this
  // button, but `cancel` is also the generic dismiss/close-dialog label used all over this
  // file family -- sharing it here read as "Cancel" out of context. Own key, ported from the
  // cloud's `tile.cancelQueuedOpen` wording (itself ported from the legacy
  // `ValveCancelButton.tsx`'s `stregaValve.cancelQueuedOpen`).
  const primaryAction = isPendingCommand
    ? { label: t('cancelQueuedOpen'), onClick: onCancel }
    : { label: t('open'), onClick: onOpen };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start gap-3">
        <ValveGlyph state={glyph.state} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* This row (unlike the six device cards, which pin the badge flush right with
                justify-between) has no justify-between -- the zone badge sits directly beside
                the name. EditableName's edit-mode wrapper carries flex-1, and this row is a
                flex container, so without this block-level div breaking that inheritance the
                input would grow to fill the row and shove the badge to the far edge (or wrap
                it under flex-wrap) the moment the pencil is pressed. The div keeps EditableName
                sized to its own content in both modes, so the badge never moves. */}
            <div className="min-w-0">
              <EditableName
                name={valve.name}
                canEdit={canEdit}
                onSave={onRename}
                renameLabel={tDevices('rename.device' as TranslationKey)}
                inputLabel={tDevices('rename.deviceInputLabel' as TranslationKey)}
                headingClassName="truncate text-sm font-semibold text-[var(--text)]"
              />
            </div>
            <span className="shrink-0 rounded-full bg-[var(--card)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
              {valve.zoneName ?? t('unassignedZone')}
            </span>
          </div>
          <p className={`mt-1 text-sm ${neverSeen ? 'font-semibold text-[var(--warn-text)]' : 'text-[var(--text-secondary)]'}`}>
            {stateLabel}
            {statusDetails.length > 0 && <span className="text-[var(--text-tertiary)]"> · {statusDetails.join(' · ')}</span>}
            {climatePair && (
              <span className="text-[var(--text-tertiary)]">
                {' · '}
                <span className="inline-block whitespace-nowrap">{climatePair}</span>
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{nextRunLine}</p>
          {planLine && (
            <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
              {planLine}
            </p>
          )}
        </div>
        {/* I6: top-right, subtle -- shared by every ValveTile placement automatically. */}
        <span className="shrink-0 whitespace-nowrap text-xs text-[var(--text-tertiary)]">{lastSeenLabel}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={primaryAction.onClick}
          disabled={busy}
          className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy && <Spinner />}
          {primaryAction.label}
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSchedule}
            disabled={busy}
            className="flex min-h-[44px] flex-1 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('schedule')}
          </button>
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              disabled={busy}
              aria-label={t('more')}
              title={t('more')}
              className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-[var(--border)] px-2.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                menuOpen ? 'bg-[var(--primary)] text-white' : 'bg-[var(--card)] text-[var(--text)] hover:bg-[var(--secondary-bg)]'
              }`}
            >
              ⋯
            </button>
            {menuOpen && (
              <div
                ref={menuRef}
                role="menu"
                className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl"
              >
                <MenuItem
                  label={t('skipToday')}
                  disabled={alreadySkipped}
                  onClick={() => { setMenuOpen(false); onSkipToday(); }}
                />
                <MenuItem
                  label={isPaused ? t('resumeSchedules') : t('pauseSchedules')}
                  onClick={() => { setMenuOpen(false); isPaused ? onResume() : onPause(); }}
                />
                <MenuItem
                  label={t('resendPlan')}
                  onClick={() => { setMenuOpen(false); onResend(); }}
                />
                <MenuItem
                  label={t('settings')}
                  onClick={() => { setMenuOpen(false); onSettings(); }}
                />
                {/* Low-prominence entry point to the service dialog (E1: no independent
                    entry point of its own) -- an overflow item, not a primary button. */}
                <MenuItem
                  label={t('service')}
                  onClick={() => { setMenuOpen(false); onService(); }}
                />
                {/* #171 item 5: reachable, but deliberately not adjacent to the primary
                    Open button -- unlike the legacy card, which puts its remove ✕ beside
                    a one-tap water-moving control. */}
                <MenuItem
                  label={t('deleteMenuItem')}
                  onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {confirmDelete && (
        <div className="rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2">
          <p className="text-sm font-semibold text-[var(--warn-text)]">{t('deleteConfirmTitle')}</p>
          <p className="mt-0.5 text-xs text-[var(--warn-text)]">{t('deleteConfirmBody')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => { setConfirmDelete(false); onDelete(); }}
              disabled={busy}
              className="flex min-h-[44px] items-center gap-2 rounded-lg bg-[var(--warn-border)] px-4 py-2 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy && <Spinner />}
              {t('deleteConfirmButton')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              disabled={busy}
              className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      {/* I6: battery footer -- omitted entirely (not "—") when absent, never fabricated
          from a missing/invalid sensor value. */}
      {battery !== null && (
        <p className="border-t border-[var(--border)] pt-2 text-xs text-[var(--text-tertiary)]">
          {t('battery', { percent: battery })}
        </p>
      )}
    </div>
  );
};

const MenuItem: React.FC<{ label: string; onClick: () => void; disabled?: boolean }> = ({ label, onClick, disabled }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    disabled={disabled}
    className="flex min-h-[44px] w-full items-center rounded-md px-3 py-2 text-left text-sm text-[var(--text)] transition-colors hover:bg-[var(--card)] disabled:cursor-not-allowed disabled:opacity-50"
  >
    {label}
  </button>
);

export default ValveTile;
