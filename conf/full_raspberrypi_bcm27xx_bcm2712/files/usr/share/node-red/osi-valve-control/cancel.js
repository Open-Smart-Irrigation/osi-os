'use strict';
// Cancel STREGA Actuation - the shared core behind two entry points: the REST route
// POST /api/v1/valves/:deveui/cancel (flows.json node "Cancel STREGA Actuation") and the
// cloud->edge CANCEL_VALVE_ACTUATION command applier in cloud-commands.js. One code path,
// two entry points - the same pattern documented at the top of cloud-commands.js.
//
// Cancellation deletes ONE actuation's pending open downlink and marks its
// valve_actuation_expectations row CANCELLED when that deletion is proven. It NEVER sends a
// downlink to the valve - a bare CLOSE must never be sent to a STREGA valve - and it does not
// close a valve that is already open (owner decision D04).
//
// Which actuation (#428): the caller names it (expectationId); a cancel that names none is
// accepted only while exactly one actuation is active, and refused as ambiguous_actuation
// otherwise -- it never picks the newest. A named actuation that has already ended is
// refused as actuation_not_active. Both refusals are permanent and change nothing.
//
// Which queue items: with a ChirpStack transport (every production entry point passes one)
// the cancel is a whole-queue flush through dispatch.flushValveQueue, as owner decision
// D19/Q01 = (a) requires: nothing is rebuilt or replayed. The result names the outcome
// (cancelled / handed_off / already_running / uncertain, see flushForCancel) and returns
// every other owner the flush touched as structured collateral. Only a proven cancel marks
// the row CANCELLED or writes devices.target_state. Without a transport (legacy callers and
// tests) the older #428 read-and-refill path below still applies: the target's open is taken
// out, plan pushes and configuration are put back in order, other actuations' opens are not
// put back and are named in droppedOpens, and an unreadable queue is flushed whole.
//
// Behavior note: when there is no active expectation to cancel, this matches the REST
// route's existing behavior exactly rather than the alternative "flush anyway, succeed
// idempotently" shape - the REST route returns 404 without touching ChirpStack's queue at
// all when it finds nothing PENDING_OBSERVATION/OBSERVED_RUNNING, so this does the same
// (no flushQueue call, ok:false) to keep both entry points identical rather than widening
// the REST route's contract as a side effect of adding the cloud path.

const runtime = require('./runtime');
const dispatch = require('./dispatch');
const store = require('./store');

const ACTIVE_STATES = "('PENDING_OBSERVATION','OBSERVED_RUNNING')";

// F96: valve_actuation_expectations.cancel_reason (SQLite TEXT, unbounded) is shipped
// VERBATIM as ValveActuation.cancel_reason by sync-bootstrap-build/sync-force-build's
// `vae.cancel_reason` column read, and the cloud's mirror column is varchar(255) -- an
// oversized reason (e.g. a cloud CANCEL_VALVE_ACTUATION command forwarding free text
// from a user-facing field) would 500 the whole cloud bootstrap the same way F96's
// result_detail overflow did. Capped here at the writer (defense in depth alongside the
// sync-bootstrap-build/sync-force-build payload boundary, which also caps this field).
const CANCEL_REASON_MAX_LENGTH = 255;
const TRUNCATION_MARKER = '…[truncated]';

function truncateWithMarker(value, maxLength) {
  if (typeof value !== 'string' || value.length <= maxLength) return value;
  if (maxLength <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, maxLength);
  return value.slice(0, maxLength - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function normalizeReason(reason) {
  // Contract types `reason` as ["string","null"] - an explicit null must be treated the
  // same as absence, not as the literal string "null".
  const trimmed = String(reason === null || reason === undefined ? '' : reason).trim();
  return trimmed || 'operator_cancel';
}

// The downlinks a timed open of this many seconds can have been sent as (flows.json
// "Build STREGA downlink": OPEN_FOR_DURATION is [0x41, minutes]; a TIMED_ACTION open is
// [0x21, seconds], [0x41, minutes] or [0x81, hours]), all on fPort 2, as hex strings.
const OPEN_FPORT = 2;
function openSignatures(durationSeconds) {
  const seconds = Number(durationSeconds);
  const out = new Set();
  if (!Number.isFinite(seconds) || seconds <= 0) return out;
  const hex = (bytes) => Buffer.from(bytes).toString('hex');
  out.add(hex([0x41, Math.min(255, Math.max(1, Math.ceil(seconds / 60)))]));
  if (Number.isInteger(seconds) && seconds <= 255) out.add(hex([0x21, seconds]));
  if (seconds % 3600 === 0 && seconds / 3600 <= 255) out.add(hex([0x81, seconds / 3600]));
  return out;
}

function itemSignature(item) {
  if (!item || Number(item.fPort) !== OPEN_FPORT || item.isPending || item.isEncrypted) return null;
  try { return Buffer.from(String(item.data || ''), 'base64').toString('hex'); }
  catch (_) { return null; }
}

// Index (into items) of the target's open downlink, or -1 when it is no longer queued.
// ChirpStack sends a device's queue first in, first out, so among the active actuations
// whose open looks like the target's, the newest k still have their open queued, where k
// is the number of matching queue items: the target's item is found by its rank.
function targetQueueIndex(items, active, target) {
  const signatures = openSignatures(target.commanded_duration_seconds);
  const matching = [];
  items.forEach((item, index) => { if (signatures.has(itemSignature(item))) matching.push(index); });
  const peers = active.filter((row) => {
    for (const signature of openSignatures(row.commanded_duration_seconds)) {
      if (signatures.has(signature)) return true;
    }
    return false;
  });
  const rank = peers.findIndex((row) => row.expectation_id === target.expectation_id);
  if (rank < 0) return -1;
  const position = matching.length - (peers.length - rank);
  return position >= 0 ? matching[position] : -1;
}

// The active actuation each queued open belongs to, by the same first-in-first-out rank
// rule: among the actuations whose open has this downlink, the newest m still have it
// queued, where m is the number of such items. null where no known actuation fits.
function queuedOpenOwners(items, active) {
  const owners = new Map();
  const bySignature = new Map();
  items.forEach((item, index) => {
    if (!isOpenItem(item)) return;
    const signature = itemSignature(item);
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature).push(index);
  });
  for (const [signature, indexes] of bySignature) {
    const peers = active.filter((row) => openSignatures(row.commanded_duration_seconds).has(signature));
    indexes.forEach((index, i) => {
      const rank = i - (indexes.length - peers.length);
      owners.set(index, rank >= 0 ? peers[rank].expectation_id : null);
    });
  }
  return owners;
}

// Reports the other actuations' opens a cancel took out of the queue. Their rows are not
// marked CANCELLED: the open may already have been sent, and the reconciler still observes.
function droppedOpens(items, removed, active, target, eui, warn) {
  const owners = queuedOpenOwners(items, active);
  const ids = [];
  let count = 0;
  items.forEach((item, index) => {
    if (removed(index) && isUnboundedMoveItem(item)) {
      count += 1;
      warn && warn('[valve-control] cancelActuation: the cancel of ' + target.expectation_id + ' on ' + eui +
        ' took out a queued partial-opening or flushing downlink (fPort ' + Number(item.fPort) + '); it is not sent');
      return;
    }
    if (!removed(index) || !isOpenItem(item) || owners.get(index) === target.expectation_id) return;
    count += 1;
    const id = owners.get(index);
    if (id) ids.push(id);
    warn && warn('[valve-control] cancelActuation: the cancel of ' + target.expectation_id + ' on ' + eui +
      ' took out the queued open of ' + (id ? 'actuation ' + id : 'an unknown actuation') + '; it is not sent');
  });
  return { count, expectationIds: ids };
}

async function resolveTarget(db, eui, expectationId) {
  const active = await db.all(
    'SELECT expectation_id, reconciliation_state, commanded_duration_seconds, command_id, transport_json FROM valve_actuation_expectations ' +
      'WHERE UPPER(device_eui) = UPPER(?) AND reconciliation_state IN ' + ACTIVE_STATES +
      ' ORDER BY commanded_at ASC, rowid ASC',
    [eui]
  );
  // A permanent CLOSE owner (commanded_duration_seconds 0, reserved so fresh CLOSED evidence can
  // settle it) is not an open: a cancel never targets or flushes it, and it never makes an
  // id-less cancel of the one real open ambiguous (D04: cancel deletes a pending open).
  const cancellable = active.filter((row) => !dispatch.isReportOnlyExpectation(row) && Number(row.commanded_duration_seconds) > 0);
  if (expectationId) {
    const named = await db.get(
      'SELECT expectation_id, reconciliation_state FROM valve_actuation_expectations ' +
      'WHERE expectation_id = ? AND UPPER(device_eui) = UPPER(?) LIMIT 1',
      [expectationId, eui]
    );
    // Not known (yet): the same answer as a cancel with nothing to cancel.
    if (!named) return { error: 'no_active_actuation' };
    const target = cancellable.find((row) => row.expectation_id === named.expectation_id);
    if (!target) return { error: 'actuation_not_active', permanent: true };
    return { target, active: cancellable };
  }
  if (cancellable.length === 0) return { error: 'no_active_actuation' };
  if (cancellable.length > 1) return { error: 'ambiguous_actuation', permanent: true, active: cancellable };
  return { target: cancellable[0], active: cancellable };
}

// An open downlink of any duration: fPort 2, first byte 0x21, 0x41 or 0x81.
function isOpenItem(item) {
  const signature = itemSignature(item);
  return !!signature && ['21', '41', '81'].includes(signature.slice(0, 2));
}

// A partial opening ([0x31, pct] on fPort 27) or a flushing (fPort 28): the valve moves open
// with no end time, so such an item is never queued again either.
function isUnboundedMoveItem(item) {
  if (!item || item.isPending || item.isEncrypted) return false;
  if (Number(item.fPort) === 28) return true;
  if (Number(item.fPort) !== 27) return false;
  try { return Buffer.from(String(item.data || ''), 'base64')[0] === 0x31; }
  catch (_) { return false; }
}

// The owners a cancel flush touched besides the target, read back from the durable flush
// intent dispatch.flushValveQueue persisted (valve_settings.conditional_control_json.flushes).
// in_queue: true when the queue snapshot taken just before the flush still held the owner's
// item unsent (the flush removed it), false when it did not (already sent or never queued),
// null when the owner had no queue id to look for.
function snapshotHolds(snapshot, queueId) {
  if (!queueId || !Array.isArray(snapshot)) return null;
  return snapshot.some((item) => item && (item.id || item.queue_id || item.queueId) === queueId && !(item.isPending || item.is_pending));
}

async function flushCollateral(db, eui, flushed, targetId) {
  if (!flushed || !flushed.flush_id) return [];
  const settings = await db.get('SELECT conditional_control_json FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [eui]);
  let control = {};
  try { control = settings && settings.conditional_control_json ? JSON.parse(settings.conditional_control_json) : {}; }
  catch (_) { control = {}; }
  const intent = (Array.isArray(control.flushes) ? control.flushes : []).find((entry) => entry && entry.flush_id === flushed.flush_id);
  if (!intent) return [];
  const snapshot = Array.isArray(flushed.snapshot) ? flushed.snapshot : intent.captured_snapshot;
  const opaque = Array.isArray(control.opaque) ? control.opaque : [];
  const out = [];
  for (const owner of Array.isArray(intent.owners) ? intent.owners : []) {
    if (!owner || (owner.type === 'expectation' && owner.id === targetId)) continue;
    const queueId = owner.queue_id || null;
    const entry = { owner_type: owner.type, owner_id: owner.id };
    if (owner.type === 'push') {
      const push = await db.get('SELECT purpose, weekday FROM valve_schedule_pushes WHERE push_id=?', [owner.id]);
      entry.purpose = push ? push.purpose : null;
      entry.weekday = push && push.weekday != null ? Number(push.weekday) : null;
    } else if (owner.type === 'expectation') {
      entry.expectation_id = owner.id;
    } else if (owner.type === 'opaque') {
      const item = opaque.find((o) => o && (o.owner_id === owner.id || o.queue_id === owner.id));
      const fport = item ? (item.fPort == null ? item.fport : item.fPort) : null;
      entry.fport = fport == null ? null : Number(fport);
    }
    entry.queue_id = queueId;
    entry.phase_before = owner.phase || null;
    entry.in_queue = snapshotHolds(snapshot, queueId);
    out.push(entry);
  }
  return out;
}

function droppedFromCollateral(collateral) {
  const ids = collateral.filter((c) => c.owner_type === 'expectation').map((c) => c.owner_id);
  return { count: ids.length, expectationIds: ids };
}

// D19/Q01 = (a): with a transport, a cancel is a whole-queue flush through the accepted
// Task 4 core, which owns every STREGA queue mutation; nothing is rebuilt or replayed. A
// queue snapshot cannot prove that an item already crossed the radio handoff, so the
// outcome is decided from evidence:
//   cancelled      the target's own queue item was in the pre-flush snapshot, unsent;
//   handed_off     it was not (sent, pending, or never had a queue id): the open may
//                  already have reached the valve, so nothing is marked;
//   already_running the valve is observed open: there is no pending command to delete,
//                  so nothing is flushed (no collateral);
//   uncertain      the flush itself failed or its outcome is unknown.
// D04: a cancel deletes the pending command. It never closes a valve that is already open.
async function flushForCancel({ db, eui, target, transport, now }) {
  if (target.reconciliation_state === 'OBSERVED_RUNNING') {
    return { ok: true, outcome: 'already_running', scope: 'not_queued', flushed: null, kept: 0, lost: 0, collateral: [], dropped: { count: 0, expectationIds: [] } };
  }
  let before = null;
  try { before = target.transport_json ? JSON.parse(target.transport_json) : null; }
  catch (_) { before = null; }
  const noFlush = (outcome, extra) => ({ ok: true, outcome, scope: 'not_queued', flushed: null, kept: 0, lost: 0, collateral: [], dropped: { count: 0, expectationIds: [] }, ...(extra || {}) });
  if (before && before.invalidated_by_flush && before.first_invalidated_by_flush != null) {
    // An earlier COMPLETED flush already took this open out of the queue. Its proof, persisted
    // on the row at that flush (R3-B1), says whether the item was still unsent then: if so the
    // open can never be delivered and the cancel is proven; otherwise it may have been sent.
    // Flushing again could only add collateral. (R3-M5: after a flush that did not complete
    // there is no proof, and the retry below flushes again.)
    return noFlush(before.unsent_in_snapshot === true ? 'cancelled' : 'handed_off');
  }
  // proves(snapshot): the flush's own pre-flush snapshot held the target's item unsent.
  let proves = () => false;
  if (before) {
    // R3-M4: only an open that may sit in the ChirpStack queue is worth a flush.
    const phase = before.phase || null;
    const neverSent = (!phase && !before.attempted_at && !before.attempt_receipt)
      || (phase === 'INTENT' && !before.attempted_at)
      || phase === 'enqueue_failed_before_acceptance' || phase === 'enqueue_rejected';
    // A local removal: the reservation proves the open never reached ChirpStack. A reservation
    // without a phase is stamped terminal, so a replay of the same command cannot resume it.
    if (neverSent) return noFlush('cancelled', { stampNeverSent: !phase || phase === 'INTENT' });
    if (before.queue_id && (phase === 'ACCEPTED' || phase === 'UNKNOWN')) {
      proves = (snapshot) => snapshotHolds(snapshot, before.queue_id) === true;
    } else if ((phase === 'ATTEMPTED' || phase === 'UNKNOWN') && !before.queue_id) {
      // R3-M4b: the enqueue answer was lost, so there is no queue id, but the exact frame is in
      // the effect snapshot. Read the queue first: a matching unsent item is flushed and the
      // cancel proven; another unsent water-moving item is flushed too (the operator asked for
      // the open to stop) and answered handed_off; otherwise nothing is flushed.
      const frame = before.effect_snapshot;
      const matchesFrame = (item) => Boolean(frame && item && !(item.isPending || item.is_pending)
        && Number(item.fPort) === Number(frame.fPort)
        && Buffer.from(String(item.data || ''), 'base64').toString('hex').toUpperCase() === String(frame.bytes_hex || '').toUpperCase());
      let items = null;
      try {
        const read = typeof transport.getDeviceQueue === 'function' ? transport.getDeviceQueue.bind(transport) : transport.getQueue.bind(transport);
        items = await read(eui);
      } catch (_) {
        items = null;
      }
      if (!Array.isArray(items)) return noFlush('handed_off');
      if (!items.some(matchesFrame) && !items.some((item) => isOpenItem(item) || isUnboundedMoveItem(item))) return noFlush('handed_off');
      proves = (snapshot) => Array.isArray(snapshot) && snapshot.some(matchesFrame);
    } else {
      return noFlush('handed_off');
    }
  }
  // No transport evidence at all: an open from the pre-transport writer. The flush is kept for
  // it, since it may still sit in the queue; it cannot be proven, so it answers handed_off.
  const flushed = await dispatch.flushValveQueue({ db, deviceEui: eui, reason: 'cancel', transport, now });
  const collateral = await flushCollateral(db, eui, flushed, target.expectation_id);
  const dropped = droppedFromCollateral(collateral);
  // R3-M2: a clock sync this flush killed is SUPERSEDED and the clock tick re-armed.
  if (flushed && flushed.flush_id) await store.supersedeFlushedClock(db, eui, flushed.flush_id);
  if (!flushed || flushed.ok !== true) {
    return { ok: false, phase: flushed && flushed.phase, outcome: 'uncertain', scope: 'flush_uncertain', flushed, kept: 0, lost: 0, collateral, dropped };
  }
  return { ok: true, phase: flushed.phase, outcome: proves(flushed.snapshot) ? 'cancelled' : 'handed_off', scope: 'full_flush', flushed, kept: 0, lost: 0, collateral, dropped };
}

// Takes the target's open out of the device queue and puts plan pushes and configuration
// back. Another actuation's open is never queued again: ChirpStack may have sent it after
// the queue read, and queueing it again would water twice. Each one is reported instead.
async function removeTargetDownlink({ eui, target, active, flushQueue, readQueue, enqueue, transport, db, now, warn }) {
  // The accepted Task 4 core owns every STREGA queue mutation.  A queue
  // snapshot cannot prove that an item has not already crossed the radio
  // handoff, so the transport path deliberately flushes and reports the
  // resulting UNKNOWN owners instead of rebuilding plan/configuration items.
  if (transport) return flushForCancel({ db, eui, target, transport, now });
  let items = null;
  if (typeof readQueue === 'function' && typeof enqueue === 'function') {
    try {
      items = await readQueue(eui);
      if (!Array.isArray(items)) throw new Error('device queue is not a list');
    } catch (e) {
      items = null;
      warn && warn('[valve-control] cancelActuation: device queue unreadable, flushing all of it for ' + eui + ': ' + (e && e.message ? e.message : e));
    }
  }
  if (!items) {
    const flushed = await flushQueue(eui);
    return { scope: 'full_flush', flushed, kept: 0, lost: 0, dropped: null };
  }
  const index = targetQueueIndex(items, active, target);
  if (index < 0) {
    // The target's open cannot be told apart in the queue (its duration gives no known
    // downlink, or the queue holds more opens than the active actuations account for):
    // flush the whole queue, as before this change, rather than leave it queued.
    const opens = items.filter(isOpenItem).length;
    if (openSignatures(target.commanded_duration_seconds).size === 0 || opens > active.length) {
      warn && warn('[valve-control] cancelActuation: the cancelled open is not recognisable in the queue of ' + eui + '; flushing all of it');
      const flushed = await flushQueue(eui);
      return { scope: 'full_flush', flushed, kept: 0, lost: 0, dropped: droppedOpens(items, () => true, active, target, eui, warn) };
    }
    // The target's open has already been sent: nothing to take out.
    return { scope: 'not_queued', flushed: null, kept: items.length, lost: 0, dropped: { count: 0, expectationIds: [] } };
  }
  const flushed = await flushQueue(eui);
  const dropped = droppedOpens(items, (i) => i !== index, active, target, eui, warn);
  const keep = items.filter((item, i) => i !== index && !item.isPending && !isOpenItem(item) && !isUnboundedMoveItem(item));
  let kept = 0;
  let lost = 0;
  for (const item of keep) {
    if (item.isEncrypted) {
      lost += 1;
      warn && warn('[valve-control] cancelActuation: an encrypted queue item for ' + eui + ' cannot be queued again and was dropped');
      continue;
    }
    try {
      await enqueue({ devEui: eui, fPort: Number(item.fPort), data: item.data, confirmed: !!item.confirmed });
      kept += 1;
    } catch (e) {
      lost += 1;
      warn && warn('[valve-control] cancelActuation: could not queue an item again for ' + eui + ': ' + (e && e.message ? e.message : e));
    }
  }
  return { scope: 'target_only', flushed, kept, lost, dropped };
}

async function emitRuntimeBestEffort(db, eui, warn) {
  try { await runtime.emitRuntimeChanged(db, eui, warn); }
  catch (e) { warn && warn('[valve-control] cancelActuation: runtime emit failed: ' + (e && e.message ? e.message : e)); }
}

// all: true is for a valve leaving this gateway (unclaim.js): every active actuation is
// cancelled and the whole device queue flushed, since nothing queued for it stays wanted.
async function cancelActuation(args) {
  // R3-M4: with a transport the decision and the write run under the device's valve writer, so
  // a cancel cannot interleave with a reservation being claimed and sent. The writer is
  // re-entrant, so the flush inside runs in the same section.
  const key = String((args && args.deviceEui) || '').trim().toUpperCase();
  if (args && args.transport && /^[0-9A-F]{16}$/.test(key)) return dispatch.withValveWriter(key, () => cancelActuationLocked(args));
  return cancelActuationLocked(args);
}

async function cancelActuationLocked({ db, deviceEui, expectationId, all, reason, flushQueue, readQueue, enqueue, transport, now, warn }) {
  // Fail closed BEFORE any write. The cloud CANCEL_VALVE_ACTUATION path (Valve Cloud
  // Command Bridge) builds flushQueue inside its own try/catch and passes null when
  // createProvisioningClientFromEnv throws - without this guard, a broken ChirpStack
  // client would silently skip the flush while still marking the expectation CANCELLED and
  // closing target_state, so a queued OPEN_FOR_DURATION could still reach the valve while
  // both sides believe it was cancelled. The REST route's flushQueue is a lazily-constructed
  // closure that is always a function, so a broken ChirpStack client there throws INSIDE the
  // queue handling below instead, before the transaction runs - same fail-closed outcome.
  if (!transport && typeof flushQueue !== 'function') {
    return { ok: false, error: 'chirpstack_unavailable', downlinks: [] };
  }

  const eui = String(deviceEui || '').trim().toUpperCase();
  if (!eui) return { ok: false, error: 'device_eui is required', downlinks: [] };

  const device = await db.get(
    'SELECT deveui, type_id FROM devices WHERE UPPER(deveui) = UPPER(?) AND deleted_at IS NULL LIMIT 1',
    [eui]
  );
  if (!device) return { ok: false, error: 'not_found', downlinks: [] };
  if (String(device.type_id || '') !== 'STREGA_VALVE') return { ok: false, error: 'not_a_valve', downlinks: [] };

  const named = expectationId === undefined || expectationId === null ? '' : String(expectationId).trim();
  const resolved = all === true ? await resolveTarget(db, eui, '') : await resolveTarget(db, eui, named);
  if (resolved.error && !(all === true && resolved.error === 'ambiguous_actuation')) {
    return { ok: false, error: resolved.error, permanent: !!resolved.permanent, downlinks: [] };
  }
  const targets = all === true ? resolved.active : [resolved.target];
  const active = targets[targets.length - 1];

  const normalizedReason = normalizeReason(reason);
  const cancelReason = truncateWithMarker(normalizedReason, CANCEL_REASON_MAX_LENGTH);
  if (cancelReason !== normalizedReason && typeof warn === 'function') {
    warn(
      '[valve-control] cancelActuation: cancel_reason truncated to ' + CANCEL_REASON_MAX_LENGTH +
      ' chars for ' + eui + ' (full text): ' + normalizedReason
    );
  }
  const nowIso = (now || new Date()).toISOString();

  // Queue work BEFORE the write, and let a flush failure propagate uncaught: if the queue
  // can't be flushed, the expectation must not be marked CANCELLED either (fail closed,
  // nothing mutated).
  // (R5 re-review N3/N4) The emitted-snapshot marker as it was before any flush, for
  // markFlushedSnapshotLost: a change means the tick emitted during the flush. No clock.
  const emittedRawBeforeFlush = await store.getSnapshotEmittedRaw(db, eui);
  const queue = all === true
    ? (transport
      // Awaited: without it `queue` was a Promise, `queue.ok` undefined, and every unclaim with a
      // transport answered transport_uncertain after flushing (found by the PR0 H1 test run on
      // the transport path).
      ? await dispatch.flushValveQueue({ db, deviceEui: eui, reason: 'unclaim', transport, now }).then((flushed) => ({ scope: flushed.ok ? 'full_flush' : 'flush_uncertain', flushed, kept: 0, lost: 0, dropped: null, ...flushed }))
      : { scope: 'full_flush', flushed: await flushQueue(eui), kept: 0, lost: 0, dropped: null })
    : await removeTargetDownlink({ eui, target: active, active: resolved.active, flushQueue, readQueue, enqueue, transport, db, now, warn });
  const base = {
    downlinks: [],
    expectationId: active.expectation_id,
    previousState: active.reconciliation_state,
    reason: cancelReason,
    timestamp: nowIso,
  };
  if (transport && all !== true && queue.outcome !== 'cancelled') {
    // Nothing is marked: the expectation keeps being observed, and devices.target_state is
    // left alone, because the open may already have reached the valve (M-3). A completed
    // whole-queue flush still removed the plan snapshot on the air (R5 H1): that loss is
    // surfaced at once here too, whatever the cancel's own outcome.
    if (queue.scope === 'full_flush') await db.transaction((tx) => store.markFlushedSnapshotLost(tx, eui, { emittedRawBeforeFlush }));
    if (queue.flushed) await emitRuntimeBestEffort(db, eui, warn);
    const uncertain = queue.outcome === 'uncertain';
    return {
      ...base,
      ok: false,
      error: uncertain ? 'transport_uncertain' : 'actuation_handed_off',
      permanent: !uncertain,
      outcome: queue.outcome,
      // The actuation may still run (the open may have been sent, or the valve is open), so a
      // caller such as the policy pause route must treat the stop as pending.
      pending: true,
      uncertainty: uncertain ? queue.flushed : null,
      queueScope: queue.scope,
      queueItemsKept: 0,
      queueItemsLost: 0,
      droppedOpens: queue.dropped,
      collateral: queue.collateral,
    };
  }
  if (transport && !queue.ok) {
    return {
      ...base,
      ok: false,
      error: 'transport_uncertain',
      outcome: 'uncertain',
      pending: true,
      uncertainty: queue,
      queueScope: 'flush_uncertain',
      queueItemsKept: 0,
      queueItemsLost: 0,
      droppedOpens: null,
      collateral: Array.isArray(queue.collateral) ? queue.collateral : null,
    };
  }

  await db.transaction(async (tx) => {
    // (R5 H1) A whole-queue flush also removed the plan snapshot on the air: surface it as LOST
    // now. Not re-sent (Q02 c); whether a cancel may arm a fresh snapshot is an owner question.
    if (queue.scope === 'full_flush') await store.markFlushedSnapshotLost(tx, eui, { emittedRawBeforeFlush });
    for (const target of targets) {
      await tx.run(
        "UPDATE valve_actuation_expectations SET reconciliation_state='CANCELLED', cancel_reason=? " +
        'WHERE expectation_id = ? AND reconciliation_state IN ' + ACTIVE_STATES,
        [cancelReason, target.expectation_id]
      );
    }
    if (queue.stampNeverSent) {
      await dispatch.updateOwnerTransportTx(tx, { type: 'expectation', id: active.expectation_id },
        { phase: 'enqueue_failed_before_acceptance', cancelled_before_send_at: nowIso });
    } else if (transport && all !== true && queue.outcome === 'cancelled') {
      // R13 R1: the flush proof (or an earlier flush's) says the open never left the queue, so the
      // cancelled expectation stops fencing the valve (dispatch cancelledUnsent).
      await dispatch.updateOwnerTransportTx(tx, { type: 'expectation', id: active.expectation_id },
        { cancelled_unsent_at: nowIso });
    }
    // Another actuation still running keeps the valve's target state.
    await tx.run(
      "UPDATE devices SET target_state='CLOSED', updated_at=? WHERE UPPER(deveui)=UPPER(?) " +
      'AND NOT EXISTS (SELECT 1 FROM valve_actuation_expectations WHERE UPPER(device_eui) = UPPER(?) ' +
      'AND reconciliation_state IN ' + ACTIVE_STATES + ')',
      [nowIso, eui, eui]
    );
  });

  // P3-E1 review fix (IMPORTANT 4): best-effort. An emit failure here must not turn a
  // successful cancel (expectation CANCELLED, queue already handled) into a reported failure --
  // a retry after that would find no_active_actuation and report a false error on an operation
  // that already fully succeeded.
  await emitRuntimeBestEffort(db, eui, warn);

  // cloud full-parity Task P4-E1: CANCELLED is one of the terminal reconciliation_states
  // -- same best-effort rationale as the runtime emit immediately above.
  for (const target of targets) {
    try { await runtime.emitActuationArchived(db, eui, target.expectation_id, warn); }
    catch (e) { warn && warn('[valve-control] cancelActuation: actuation-archive emit failed: ' + (e && e.message ? e.message : e)); }
  }

  return {
    ok: true,
    downlinks: [],
    expectationId: active.expectation_id,
    previousState: active.reconciliation_state,
    reason: cancelReason,
    queueScope: queue.scope,
    queueItemsKept: queue.kept,
    queueItemsLost: queue.lost,
    // Other actuations' opens this cancel took out of the queue (null: not known, the
    // queue could not be read). Their rows stay as they are.
    droppedOpens: queue.dropped,
    chirpstackQueueStatus: queue.flushed && queue.flushed.statusCode,
    outcome: 'cancelled',
    pending: false,
    // Every other owner the flush touched (D19/Q01 = (a)); null when no transport flush ran.
    collateral: Array.isArray(queue.collateral) ? queue.collateral : null,
    // A targeted transport cancel only reaches here with the target's item proven unsent;
    // the owners the flush removed are listed in collateral. The unclaim flush (all: true)
    // keeps its earlier report: every owner it touched is UNKNOWN.
    // (R13-m1) From the flush's real outcome: a completed flush is not uncertain, although every
    // owner it touched is UNKNOWN (dispatch answers phase UNKNOWN even when ok). Only a proven or
    // completed flush reaches this point, so with a transport this is false.
    transport_uncertain: Boolean(transport && queue.flushed && queue.flushed.ok === false),
    timestamp: nowIso,
  };
}

// Owner decision 2026-10-22 (S6): a valve leaving this gateway (the lifecycle unclaim) loses its
// queued opens through the same D19(a) path as the cancel button, one actuation at a time: the
// first cancel flushes the whole queue, and the proof each flush stamps on the other rows lets the
// next ones settle without flushing again. Nothing is ever sent, so no CLOSE (D04). An open the
// valve is already running is not touched: a STREGA open is bounded and closes itself, so it runs
// out its duration. state is the outcome that matters most to the operator:
// uncertain > handed_off > already_running > cancelled > none_active (not_attempted without a
// transport); results lists every active actuation with its own outcome.
const UNCLAIM_CANCEL_RANK = ['none_active', 'cancelled', 'already_running', 'handed_off', 'uncertain'];

async function cancelForUnclaim({ db, deviceEui, transport, now, warn } = {}) {
  const eui = String(deviceEui || '').trim().toUpperCase();
  const resolved = await resolveTarget(db, eui, '');
  const active = resolved.active || [];
  const empty = { state: 'none_active', error: null, results: [], collateral: [], whole_queue_flushed: false };
  if (!active.length) return empty;
  if (!transport) return { ...empty, state: 'not_attempted', error: 'transport_unavailable', results: active.map((row) => ({ expectation_id: row.expectation_id, outcome: 'not_attempted', error: 'transport_unavailable' })) };
  const results = [];
  const collateral = [];
  let flushed = false;
  const running = active.filter((row) => row.reconciliation_state === 'OBSERVED_RUNNING');
  for (const row of running) {
    const close = await db.get('SELECT expected_close_at FROM valve_actuation_expectations WHERE expectation_id=?', [row.expectation_id]);
    results.push({ expectation_id: row.expectation_id, outcome: 'already_running', error: null, expected_close_at: close ? close.expected_close_at : null });
  }
  for (const row of active.filter((item) => item.reconciliation_state !== 'OBSERVED_RUNNING')) {
    let out;
    try {
      out = await cancelActuation({ db, deviceEui: eui, expectationId: row.expectation_id, reason: 'device_unclaimed', transport, now, warn });
    } catch (error) {
      out = { ok: false, outcome: 'uncertain', error: String(error && error.message || error) };
    }
    const outcome = out.ok ? 'cancelled' : (out.outcome || (out.error === 'actuation_not_active' || out.error === 'no_active_actuation' ? 'none_active' : 'uncertain'));
    if (out.queueScope === 'full_flush') flushed = true;
    if (Array.isArray(out.collateral)) collateral.push(...out.collateral.filter((c) => !active.some((a) => a.expectation_id === c.expectation_id)));
    results.push({ expectation_id: row.expectation_id, outcome, error: out.ok ? null : (out.error || null) });
  }
  const state = results.reduce((worst, r) => (UNCLAIM_CANCEL_RANK.indexOf(r.outcome) > UNCLAIM_CANCEL_RANK.indexOf(worst) ? r.outcome : worst), 'none_active');
  const errors = results.filter((r) => r.outcome === 'uncertain').map((r) => r.expectation_id + ': ' + (r.error || 'uncertain'));
  return { state, error: errors.length ? errors.join('; ') : null, results, collateral, whole_queue_flushed: flushed };
}

// D04 (owner decision 2026-10-18), verbatim: the help text on every cancel control.
const CANCEL_HELP_TEXT = 'Cancel deletes the pending command. It does not close a valve that is already open.';

// The REST reply for a cancelActuation result (flows.json node cancel-strega-actuation-fn).
// Kept here so every outcome is tested next to the code that produces it.
function cancelHttpResponse(result, deveui) {
  const r = result || {};
  const collateral = Array.isArray(r.collateral) ? r.collateral : null;
  if (!r.ok) {
    const refuse = (statusCode, message, extra) => ({ statusCode, payload: { message, error: r.error || null, ...(extra || {}) } });
    if (r.error === 'ambiguous_actuation') return refuse(409, 'More than one actuation is active; name the one to cancel (expectation_id)');
    if (r.error === 'actuation_not_active') return refuse(409, 'That actuation is no longer active');
    if (r.error === 'no_active_actuation') return refuse(404, 'No active actuation to cancel');
    if (r.error === 'not_found') return refuse(404, 'Valve not found in devices table');
    if (r.error === 'not_a_valve') return refuse(409, 'Device ' + deveui + ' is not a STREGA_VALVE');
    if (r.error === 'actuation_handed_off') {
      const lead = r.outcome === 'already_running'
        ? 'The valve is already open: there is no pending command to delete. '
        : 'The open may already have been sent to the valve, so it was not cancelled. ';
      return refuse(409, lead + CANCEL_HELP_TEXT,
        { outcome: r.outcome || 'handed_off', expectation_id: r.expectationId || null, queue_scope: r.queueScope || null, collateral, dropped_opens: r.droppedOpens || null });
    }
    if (r.error === 'transport_uncertain') {
      return refuse(503, 'Cancellation transport outcome is uncertain',
        { outcome: 'uncertain', uncertainty: r.uncertainty || null, expectation_id: r.expectationId || null, collateral });
    }
    return refuse(500, r.error || 'Unable to cancel STREGA actuation');
  }
  return {
    statusCode: 200,
    payload: {
      status: 'cancelled',
      outcome: r.outcome || 'cancelled',
      confirmation: r.transport_uncertain ? 'queue_outcome_uncertain' : 'queue_flushed',
      deveui,
      cancelled: 1,
      expectation_id: r.expectationId,
      previous_state: r.previousState,
      reason: r.reason,
      chirpstack_queue_status: r.chirpstackQueueStatus,
      queue_scope: r.queueScope,
      dropped_opens: r.droppedOpens,
      collateral,
      transport_uncertain: !!r.transport_uncertain,
      timestamp: r.timestamp,
    },
  };
}

module.exports = { cancelActuation, cancelForUnclaim, cancelHttpResponse, CANCEL_HELP_TEXT };
