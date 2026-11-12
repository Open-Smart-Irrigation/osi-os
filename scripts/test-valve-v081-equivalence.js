'use strict';
// Stage 1 of the v0.8.2 valve fix: for every command that is not a conditional-irrigation
// occurrence, the gateway decides and sends what v0.8.1 decides and sends.
//
// Each sequence below is run twice by scripts/lib/valve-equivalence-harness.js: on the valve code
// of tag v0.8.1 (the oracle) and on this checkout. The traces must be equal in what the caller is
// told (accepted or refused, and the outcome of a cancel), in what the gateway hands to the radio
// side, in what the valve then does and in the state shown, except for the differences declared
// in DEVIATIONS, each of them exact in step and value. A difference that is not declared fails
// the test, and so does a declared one that no longer occurs.
//
// v0.8.1 is the oracle for what the gateway decides and sends, not for what it records. The
// records of this checkout are asserted against what was commanded: one record per open handed
// over, with its duration, and no record without a command unless the sequence declares it.
//
// VALVE_EQ_TRACE=1 prints both traces of every sequence.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./lib/valve-equivalence-harness');

const { SECOND, MINUTE, HOUR, DAY } = H;
const ORACLE = 'v0.8.1';

// Every difference from v0.8.1 that this checkout shows in these sequences.
const DEVIATIONS = {
  'report-order': { status: 'limit of the display', reason: 'The state shown is the last report the gateway accepted, not the valve\'s state. With a synchronised clock a report whose time is older than one already accepted is not accepted; v0.8.1 took whatever arrived last. That hides a delayed OPEN report of a valve that has closed since (sequence "two hours late"), and it also hides newer reports after the clock was set back, until the clock has passed the time of the newest report accepted before (sequence "set back four hours"). Nothing is decided from the state shown. Ordering across clock corrections is stage 2.' },
  'command-expiry': { status: 'exception to the v0.8.1 rule', reason: 'A cloud OPEN_FOR_DURATION that carries its own expires_at keeps the sender\'s intent, by the gateway\'s wall clock: it is not sent after that time, and before it is queued with that time as queue expiry. v0.8.1 ignored the field. With a wrong gateway clock the command is refused early or runs late, and dropping it can let a later, longer open run that the valve would have ignored.' },
  'duplicate-command': { status: 'kept', reason: 'A command id that was already handled is answered with the stored result and sends nothing. v0.8.1 failed on the primary key of its expectation row, sent nothing either, and logged an error.' },
  'cancel-target': { status: 'one direction not safer, for decision', reason: 'Which opens a cancel finds active follows the records, and the records are this release\'s. Right after a run, before v0.8.1\'s monitor had marked it, v0.8.1 answered "cancelled" with nothing to take out; here the reports have marked the run and the answer is "No active actuation". In the other direction, two opens that were queued together stay active here for about an hour after the one run they produced (the report fits both), where v0.8.1 ended both on the CLOSED report: an unnamed cancel of a third open in that hour is refused as ambiguous here and was carried out by v0.8.1. Not safer; left, because the way out is either v0.8.1\'s rule that ends commands from the state shown or a cancel that picks a target nobody named (#428).' },
  'run-history': { status: 'decided: left as it is', reason: 'The history of runs is kept by the rules of #515: a run is marked observed only from reports with a synchronised clock that fit exactly one open. v0.8.1 marked every active open from the state shown, also an open the valve had not fetched or had ignored. Compared in two sequences only; differs in most.' },
};

const used = new Set();
function sequence(name, options, script) {
  test(name, async (t) => {
    const oracle = await H.runSequence(t, options.oracle ? options.oracle() : { start: H.release(ORACLE) }, options.world, script);
    const candidate = await H.runSequence(t, options.candidate ? options.candidate() : { start: H.candidate() }, options.world, script);
    const found = H.differences(oracle, candidate, options.alsoCompare).map(({ step, field, oracle: a, candidate: b }) => ({ step, field, oracle: a, candidate: b }));
    const declared = (options.deviations || []).map(({ id, step, field, oracle: a, candidate: b }) => {
      assert.ok(DEVIATIONS[id], 'deviation ' + id + ' has no entry in DEVIATIONS');
      used.add(id);
      return { step, field, oracle: a, candidate: b };
    });
    const traces = '\n--- ' + ORACLE + '\n' + H.describe(oracle) + '\n--- this checkout\n' + H.describe(candidate) + '\n';
    if (process.env.VALVE_EQ_TRACE) for (const line of (traces + '--- differences\n' + found.map((d) => JSON.stringify(d)).join('\n')).split('\n')) t.diagnostic(line);
    assert.deepEqual(found, declared, 'differences from ' + ORACLE + ' (found) against the declared deviations (expected)' + traces);
    assert.deepEqual(candidate.errors, options.errors || [], 'errors logged by this checkout');
    // Records: compared with what was commanded, not with v0.8.1.
    assert.deepEqual(candidate.records.commanded.map((record) => record.seconds), candidate.handedOver,
      'one record per open handed to the radio side, with its commanded duration' + traces);
    if (options.commanded) assert.deepEqual(candidate.records.commanded, options.commanded, 'the commanded records' + traces);
    assert.deepEqual(candidate.records.reportOnly, options.reportOnly || [], 'records that belong to no command' + traces);
    // The answer to a cancel: v0.8.1's fields are compared above; what this checkout adds is pinned.
    for (const entry of oracle.trace.filter((item) => item.cancelAdded)) assert.deepEqual(entry.cancelAdded, {}, 'v0.8.1 answers a cancel with the compared fields only');
    for (const entry of candidate.trace.slice(candidate.comparedFrom).filter((item) => item.cancelAdded)) {
      assert.deepEqual(entry.cancelAdded, entry.decision === 'accepted' ? CANCEL_ADDED : { error: (options.cancelErrors || {})[candidate.trace.indexOf(entry)] }, 'what the answer to a cancel says beyond v0.8.1\'s' + traces);
    }
  });
}

// What this checkout's answer to an accepted cancel says beyond v0.8.1's. A refused cancel adds
// the error code beside v0.8.1's message; each sequence names it per step (cancelErrors).
const CANCEL_ADDED = { collateral: null, outcome: 'cancelled', transport_uncertain: false };

// A record that belongs to no command (trigger 'unexplained') says why. 'no_owner': no open of
// this valve fits the report. 'ambiguous_owner': more than one fits it; the gateway does not
// choose, and the commands stay without an observation.
const noCommand = (state = 'OBSERVED_COMPLETE') => ({ trigger: 'unexplained', why: 'no_owner', state });
const severalFit = (state = 'OBSERVED_COMPLETE') => ({ trigger: 'unexplained', why: 'ambiguous_owner', state });

const upgradeFrom = (tag) => () => ({ start: H.release(tag), upgradeTo: H.candidate() });
// A 0.8.2 gateway: its code on this checkout's database (see runSequence), then this checkout.
const upgradeFrom082 = () => ({ start: H.release('v0.8.2'), databaseOf: H.candidate(), upgradeTo: H.candidate() });

const cloudOpen = (id, minutes, extra) => ({ commandType: 'VALVE_COMMAND', action: 'OPEN_FOR_DURATION', durationMinutes: minutes, commandId: id, ...(extra || {}) });
const timedClose = (minutes) => ({ action: 'TIMED_ACTION', valve_action: 'CLOSE', unit: 'MINUTES', amount: minutes, reason: 'local_timed_action', payloadHex: null, fPort: 2, commandType: 'SET_STREGA_TIMED_ACTION' });
const flushing = (returnPosition) => ({ action: 'SET_FLUSHING', return_position: returnPosition, percentage: 50, reason: 'local_flushing', payloadHex: null, fPort: 28, commandType: 'SET_STREGA_FLUSHING' });
const partialOpening = (valveAction) => ({ action: 'SET_PARTIAL_OPENING', valve_action: valveAction, percentage: 50, reason: 'local_partial_opening', payloadHex: null, fPort: 27, commandType: 'SET_STREGA_PARTIAL_OPENING' });
const interval = () => ({ action: 'SET_INTERVAL', closed_interval_minutes: 10, open_interval_minutes: 2, reason: 'local_interval_config', fPort: 11, commandType: 'SET_STREGA_INTERVAL' });

// A run as the gateway sees it when both state-change uplinks of the valve are received: the valve
// reports OPEN 20 s after it fetched the open, and CLOSED when the run is over. Each received
// uplink is also a chance for ChirpStack to hand over the next queued frame.
async function watchRun(g, minutes) {
  g.wait(20 * SECOND); await g.uplink();
  g.wait(minutes * MINUTE); await g.uplink();
}

// ------------------------------------------------------------------ F-1

sequence('F-1: an open the valve never fetches, then opens 3 hours and 33 days later', {}, async (g) => {
  await g.open(2);
  g.wait(3 * HOUR); await g.ticks();
  await g.open(2);
  g.wait(33 * DAY); await g.ticks();
  await g.open(2);
  await g.close();
});

sequence('F-1: the valve runs the open, its OPEN report is not received, only CLOSED reports arrive', {}, async (g) => {
  await g.open(2);
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink({ report: 'lost' });
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(1 * HOUR); await g.uplink();
  g.wait(1 * DAY); await g.uplink(); await g.ticks();
  await g.open(2);
  g.wait(5 * MINUTE); await g.uplink();
  await watchRun(g, 2);
});

sequence('F-1 variant: a manual CLOSE the valve does not confirm for 3 hours, then an open', {}, async (g) => {
  await g.close();
  g.wait(3 * HOUR); await g.ticks();
  await g.open(2);
  g.wait(10 * MINUTE); await g.uplink({ report: 'lost' });
  g.wait(10 * MINUTE); await g.uplink();
  g.wait(10 * MINUTE); await g.uplink();
  await watchRun(g, 2);
});

sequence('F-1 variant: the valve was opened at the valve and reports OPEN; timed opens are sent and ignored, a CLOSE closes it', {
  reportOnly: [noCommand()], // the run that was started at the valve
}, async (g) => {
  await g.openedAtValve();
  g.wait(1 * MINUTE); await g.uplink();
  g.wait(1 * MINUTE); await g.open(15);
  g.wait(1 * MINUTE); await g.uplink();
  g.wait(3 * DAY); await g.ticks();
  await g.open(2);
  g.wait(2 * MINUTE); await g.uplink({ report: 'lost' });
  await g.close();
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(2 * MINUTE); await g.uplink();
});

// ------------------------------------------------------------------ F-2 and other clock states

sequence('F-2: no NTP reply since boot, a complete run and further opens', {
  world: { ntp: false },
  alsoCompare: ['history'],
  deviations: [{ id: 'run-history', step: 9, field: 'history', oracle: ['OBSERVED_COMPLETE', 'OBSERVED_COMPLETE', 'OBSERVED_COMPLETE'], candidate: ['STALE_NO_OBSERVATION', 'STALE_NO_OBSERVATION', 'PENDING_OBSERVATION'] }],
}, async (g) => {
  await g.open(2);
  g.wait(5 * MINUTE); await g.uplink();
  await watchRun(g, 2);
  await g.open(2);
  g.wait(3 * HOUR); await g.uplink();
  await watchRun(g, 2);
  await g.open(2);
});

sequence('F-2: a manual CLOSE without an NTP reply, then an open', { world: { ntp: false } }, async (g) => {
  await g.close();
  g.wait(2 * MINUTE); await g.uplink();
  await g.open(2);
  g.wait(10 * MINUTE); await g.uplink();
  await watchRun(g, 2);
});

// Measured by the image builder on the 0.8.2 image after a power cut: the valve's OPEN report
// reaches the gateway before the first time signal. 0.8.2 booked the report as a second run and
// refused every later open. Here the second open is sent, the report is attached to the one open
// it can belong to, and no second record is written. The first run is not marked observed: its
// OPEN report has no trusted time.
sequence('measured: the OPEN report arrives before the first time signal, the CLOSED report after it, a second open three minutes later', {
  world: { ntp: false },
  commanded: [
    { seconds: 60, state: 'PENDING_OBSERVATION', untrusted_report: 'closed+open' },
    { seconds: 60, state: 'OBSERVED_COMPLETE', untrusted_report: null },
  ],
}, async (g) => {
  await g.open(1);
  g.wait(5 * SECOND); await g.uplink();
  g.wait(10 * SECOND); await g.uplink();
  g.wait(35 * SECOND); await g.ntp();
  g.wait(20 * SECOND); await g.uplink();
  g.wait(3 * MINUTE); await g.open(1);
  g.wait(5 * SECOND); await g.uplink();
  await watchRun(g, 1);
});

sequence('measured, variant: both reports of the first run arrive before the first time signal', {
  world: { ntp: false },
  commanded: [
    { seconds: 120, state: 'PENDING_OBSERVATION', untrusted_report: 'closed+open' },
    { seconds: 120, state: 'OBSERVED_COMPLETE', untrusted_report: null },
  ],
}, async (g) => {
  await g.open(2);
  g.wait(5 * SECOND); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(30 * SECOND); await g.ntp();
  await g.open(2);
  g.wait(5 * SECOND); await g.uplink();
  await watchRun(g, 2);
});

// Without a time signal a report that fits two opens is attached to neither.
sequence('no time signal: two opens are queued when the valve reports OPEN', {
  world: { ntp: false },
  commanded: [
    { seconds: 120, state: 'PENDING_OBSERVATION', untrusted_report: null },
    { seconds: 120, state: 'PENDING_OBSERVATION', untrusted_report: null },
  ],
  reportOnly: [severalFit('OBSERVED_RUNNING')],
}, async (g) => {
  await g.open(2);
  g.wait(12 * SECOND); await g.open(2);
  g.wait(1 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
  g.wait(2 * MINUTE); await g.uplink();
});

// Without a time signal a valve that already reported OPEN gives a later open no report of its own.
sequence('no time signal: the valve was opened at the valve, reports OPEN, and a timed open follows', {
  world: { ntp: false },
  commanded: [{ seconds: 900, state: 'PENDING_OBSERVATION', untrusted_report: null }],
  reportOnly: [noCommand('OBSERVED_RUNNING')],
}, async (g) => {
  await g.openedAtValve();
  g.wait(1 * MINUTE); await g.uplink();
  g.wait(1 * MINUTE); await g.open(15);
  g.wait(1 * MINUTE); await g.uplink();
  g.wait(1 * MINUTE); await g.uplink();
  await g.close();
  g.wait(1 * MINUTE); await g.uplink();
  g.wait(1 * MINUTE); await g.uplink();
});

sequence('clock four hours behind, then the NTP reply steps it forward while an open is queued', { world: { ntp: false, offsetMs: -4 * HOUR } }, async (g) => {
  await g.open(2);
  g.wait(5 * MINUTE); await g.uplink();
  await watchRun(g, 2);
  g.wait(10 * MINUTE);
  await g.open(15);
  g.wait(1 * MINUTE); await g.stepClock(4 * HOUR); await g.ntp();
  g.wait(4 * MINUTE); await g.uplink();
  await watchRun(g, 15);
  await g.open(2);
});

// Sol's finding 1 as a sequence. Both opens run, in v0.8.1 and here: nothing fences the retry.
sequence('clock four hours ahead, set back while an open is queued, a retry 40 minutes later: both run', { world: { ntp: false, offsetMs: 4 * HOUR } }, async (g) => {
  await g.open(2);
  g.wait(1 * MINUTE); await g.stepClock(-4 * HOUR); await g.ntp();
  g.wait(40 * MINUTE); await g.ticks();
  await g.open(2);
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink({ report: 'lost' });
  g.wait(10 * MINUTE); await g.uplink();
  await watchRun(g, 2);
});

sequence('synchronised clock that steps forward and back without a new NTP reply', {}, async (g) => {
  await g.open(2);
  g.wait(1 * MINUTE); await g.stepClock(90 * MINUTE);
  g.wait(4 * MINUTE); await g.uplink();
  await watchRun(g, 2);
  await g.open(2);
  g.wait(1 * MINUTE); await g.stepClock(-90 * MINUTE);
  g.wait(4 * MINUTE); await g.uplink();
  await watchRun(g, 2);
  await g.close();
  g.wait(1 * MINUTE); await g.stepClock(90 * MINUTE);
  g.wait(4 * MINUTE); await g.uplink();
});

// Sol's review 2, finding 1: the clock is corrected after the command was reserved and before its
// frame is handed over. No ordinary command is refused for it: the gateway generates no cutoff of
// its own for them. (0.8.2 and revision 2 answered 503 command_expired on a forward correction.)
const CORRECTIONS = {
  'the first time signal sets the clock four hours forward': { world: { ntp: false, offsetMs: -4 * HOUR }, stepMs: 4 * HOUR },
  'a new time signal sets the clock four hours forward': { world: {}, stepMs: 4 * HOUR },
  'a new time signal sets the clock four hours back': { world: { offsetMs: 4 * HOUR }, stepMs: -4 * HOUR },
};
const CORRECTED = {
  'a manual open': { send: (g) => g.open(2) },
  'a one-time schedule': { send: (g) => g.oneTime(2) },
  // The valve was opened at the valve, so that the CLOSE has something to close.
  'a manual CLOSE': { before: (g) => g.openedAtValve(), send: (g) => g.close(), reportOnly: [noCommand()] },
};
for (const [correction, { world, stepMs }] of Object.entries(CORRECTIONS)) {
  for (const [what, { before, send, reportOnly }] of Object.entries(CORRECTED)) {
    sequence(what + ': ' + correction + ' between its reservation and the hand-over of its frame', { world, reportOnly }, async (g) => {
      if (before) await before(g);
      let corrected = false;
      g.atReservation(() => { g.world.stepClock(stepMs); g.world.ntpReply(); corrected = true; });
      await send(g);
      assert.ok(corrected, 'the clock was corrected between reservation and hand-over');
      g.wait(5 * MINUTE); await g.uplink();
      await watchRun(g, 2);
    });
  }
}

// ------------------------------------------------------------------ reboots

sequence('a reboot between acceptance and the valve fetching the open, and a second open during the run', {}, async (g) => {
  await g.open(15);
  g.wait(2 * MINUTE); await g.reboot();
  g.wait(3 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
  await g.open(15);
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(13 * MINUTE); await g.uplink();
  await g.open(2);
});

// Sol's finding 3 as a sequence: no boot is long enough to wait out anything.
sequence('six boots of 20 minutes after an open the valve has not fetched, no NTP reply, then a second open', {}, async (g) => {
  await g.open(2);
  for (let boot = 0; boot < 6; boot += 1) { g.wait(20 * MINUTE); await g.reboot(); await g.ticks(); }
  await g.open(2);
  g.wait(5 * MINUTE); await g.uplink();
  await watchRun(g, 2);
  g.wait(5 * MINUTE); await g.uplink();
});

// ------------------------------------------------------------------ reports

sequence('an OPEN report that reaches the gateway software two hours late', {
  deviations: [
    { id: 'report-order', step: 4, field: 'shown', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'report-order', step: 5, field: 'shown', oracle: 'OPEN', candidate: 'CLOSED' },
  ],
}, async (g) => {
  await g.open(2);
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink({ report: 'late' });
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(2 * HOUR); await g.deliverHeld('late');
  await g.open(2);
  g.wait(10 * MINUTE); await g.uplink();
  await watchRun(g, 2);
});

// Sol's review 2, finding 4, pinned as it is today: after the clock was set back, reports are not
// accepted until the clock has passed the time of the newest report accepted before. The state
// shown stays behind for that long; every command is sent as in v0.8.1.
sequence('the clock is set back four hours by a new time signal: reports are not accepted until the clock has passed the newest one accepted before', {
  world: { offsetMs: 4 * HOUR },
  deviations: [
    { id: 'report-order', step: 5, field: 'shown', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'report-order', step: 6, field: 'shown', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'report-order', step: 8, field: 'shown', oracle: 'OPEN', candidate: 'CLOSED' },
  ],
  // Neither run before the clock caught up has an accepted report: both stay without observation.
  commanded: [
    { seconds: 120, state: 'STALE_NO_OBSERVATION', untrusted_report: null },
    { seconds: 120, state: 'STALE_NO_OBSERVATION', untrusted_report: null },
    { seconds: 120, state: 'OBSERVED_COMPLETE', untrusted_report: null },
  ],
}, async (g) => {
  await g.uplink();
  await g.stepClock(-4 * HOUR); await g.ntp();
  await g.open(2);
  await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
  await g.open(2);
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(4 * HOUR); await g.uplink();
  await g.open(2);
  g.wait(1 * MINUTE); await g.uplink();
  await watchRun(g, 2);
});

// ------------------------------------------------------------------ several origins on one valve

// Two opens are queued when the valve reports OPEN: the report fits both.
sequence('scheduler and manual open on one valve, both orders', { reportOnly: [severalFit(), severalFit()] }, async (g) => {
  await g.scheduler(15);
  g.wait(30 * SECOND); await g.open(15);
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
  g.wait(15 * MINUTE); await g.uplink();
  g.wait(1 * DAY); await g.ticks();
  await g.open(15);
  g.wait(5 * MINUTE); await g.scheduler(15);
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
  g.wait(15 * MINUTE); await g.uplink();
});

sequence('F-11: a scheduler open alone is labelled as the scheduler', {}, async (g) => {
  await g.scheduler(15);
  g.wait(5 * MINUTE); await g.uplink();
  await watchRun(g, 15);
});

sequence('a one-time schedule fires, then a manual open', { reportOnly: [severalFit()] }, async (g) => {
  await g.oneTime(15);
  g.wait(1 * MINUTE); await g.open(15);
  g.wait(4 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
  g.wait(15 * MINUTE); await g.uplink();
});

sequence('a cloud open, its duplicate, a second command six hours late, its duplicate and a cloud CLOSE', {
  // v0.8.1 gave the duplicate no answer; here it gets the stored result of the first.
  deviations: [
    { id: 'duplicate-command', step: 1, field: 'decision', oracle: 'refused', candidate: 'accepted' },
    { id: 'duplicate-command', step: 3, field: 'decision', oracle: 'refused', candidate: 'accepted' },
  ],
}, async (g) => {
  await g.cloud('open 5 min', cloudOpen('cloud-0001', 5));
  await g.cloud('open 5 min, same command id', cloudOpen('cloud-0001', 5));
  g.wait(6 * HOUR); await g.ticks();
  await g.cloud('open 5 min, a second command, six hours late', cloudOpen('cloud-0002', 5));
  await g.cloud('open 5 min, the second command again', cloudOpen('cloud-0002', 5));
  await g.cloud('CLOSE', { commandType: 'CLOSE', commandId: 'cloud-0003' });
  g.wait(5 * MINUTE); await g.uplink();
  await watchRun(g, 5);
  g.wait(1 * MINUTE); await g.uplink();
  g.wait(1 * MINUTE); await g.uplink();
});

sequence('cloud commands that carry an expiry of their own', {
  deviations: [
    { id: 'command-expiry', step: 0, field: 'expiry', oracle: [null], candidate: [60] },
    { id: 'command-expiry', step: 1, field: 'decision', oracle: 'accepted', candidate: 'refused' },
    { id: 'command-expiry', step: 1, field: 'sent', oracle: true, candidate: false },
    { id: 'command-expiry', step: 1, field: 'frames', oracle: ['2:4105'], candidate: [] },
    { id: 'command-expiry', step: 1, field: 'expiry', oracle: [null], candidate: [] },
    // The expired command is the third frame v0.8.1 queued; what follows is its run.
    // VALVE_COMMAND (step 2) drops expires_at before the valve code sees it; that is unchanged.
    { id: 'command-expiry', step: 6, field: 'delivered', oracle: '2:4105', candidate: null },
    { id: 'command-expiry', step: 6, field: 'valve', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 7, field: 'reported', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 7, field: 'valve', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 7, field: 'shown', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 9, field: 'runs', oracle: [[5, 10], [10.33, 15.33], [20.33, 25.33]], candidate: [[5, 10], [10.33, 15.33]] },
    { id: 'command-expiry', step: 9, field: 'labels', oracle: ['manual', 'manual', 'manual'], candidate: ['manual', 'manual'] },
  ],
}, async (g) => {
  const inOneHour = new Date(Date.now() + HOUR).toISOString();
  const oneHourAgo = new Date(Date.now() - HOUR).toISOString();
  await g.cloud('OPEN_FOR_DURATION 5 min, expires in one hour', { commandType: 'OPEN_FOR_DURATION', duration_minutes: 5, commandId: 'cloud-exp-1', expires_at: inOneHour });
  await g.cloud('OPEN_FOR_DURATION 5 min, expired one hour ago', { commandType: 'OPEN_FOR_DURATION', duration_minutes: 5, commandId: 'cloud-exp-2', expires_at: oneHourAgo });
  await g.cloud('VALVE_COMMAND 5 min, expires_at one hour ago', cloudOpen('cloud-exp-3', 5, { expires_at: oneHourAgo }));
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink({ report: 'lost' });
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(10 * MINUTE); await g.uplink();
  g.wait(1 * MINUTE); await g.uplink();
  g.wait(10 * MINUTE); await g.uplink();
});

sequence('a cloud open with its own expiry that the valve fetches too late is discarded by ChirpStack', {
  deviations: [
    { id: 'command-expiry', step: 0, field: 'expiry', oracle: [null], candidate: [30] },
    { id: 'command-expiry', step: 1, field: 'delivered', oracle: '2:4105', candidate: null },
    { id: 'command-expiry', step: 1, field: 'discarded', oracle: [], candidate: ['2:4105'] },
    { id: 'command-expiry', step: 1, field: 'valve', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 2, field: 'reported', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 2, field: 'valve', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 2, field: 'shown', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 4, field: 'runs', oracle: [[45, 50]], candidate: [] },
  ],
}, async (g) => {
  await g.cloud('OPEN_FOR_DURATION 5 min, expires in 30 minutes', { commandType: 'OPEN_FOR_DURATION', duration_minutes: 5, commandId: 'cloud-exp-4', expires_at: new Date(Date.now() + 30 * MINUTE).toISOString() });
  g.wait(45 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
  g.wait(5 * MINUTE); await g.uplink();
});

// Sol's review 2, finding 5: the sender's expiry is kept by the gateway's wall clock. A clock that
// runs ahead refuses a command the sender still wants; a clock that runs behind sends one the
// sender has given up; and a dropped short open lets a later, longer one run.
sequence('a sender\'s expiry on a gateway whose clock is four hours ahead: a command that is still wanted is refused', {
  world: { offsetMs: 4 * HOUR },
  deviations: [
    { id: 'command-expiry', step: 0, field: 'decision', oracle: 'accepted', candidate: 'refused' },
    { id: 'command-expiry', step: 0, field: 'sent', oracle: true, candidate: false },
    { id: 'command-expiry', step: 0, field: 'frames', oracle: ['2:4102'], candidate: [] },
    { id: 'command-expiry', step: 0, field: 'expiry', oracle: [null], candidate: [] },
    { id: 'command-expiry', step: 1, field: 'delivered', oracle: '2:4102', candidate: null },
    { id: 'command-expiry', step: 1, field: 'valve', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 2, field: 'reported', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 2, field: 'valve', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 2, field: 'shown', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 3, field: 'shown', oracle: 'OPEN', candidate: 'CLOSED' },
    { id: 'command-expiry', step: 3, field: 'runs', oracle: [[5, 'still open']], candidate: [] },
    { id: 'command-expiry', step: 3, field: 'labels', oracle: ['manual'], candidate: [] },
  ],
}, async (g) => {
  await g.cloud('OPEN_FOR_DURATION 2 min, expires in one hour', { commandType: 'OPEN_FOR_DURATION', duration_minutes: 2, commandId: 'cloud-exp-5', expires_at: new Date(g.world.real + HOUR).toISOString() });
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
});

sequence('a sender\'s expiry on a gateway whose clock is four hours behind: a command the sender gave up is sent', {
  world: { ntp: false, offsetMs: -4 * HOUR },
  // Sent as in v0.8.1; ChirpStack is told to keep the frame for another 239 minutes.
  deviations: [{ id: 'command-expiry', step: 0, field: 'expiry', oracle: [null], candidate: [239] }],
}, async (g) => {
  await g.cloud('OPEN_FOR_DURATION 2 min, expired one minute ago', { commandType: 'OPEN_FOR_DURATION', duration_minutes: 2, commandId: 'cloud-exp-6', expires_at: new Date(g.world.real - MINUTE).toISOString() });
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
});

sequence('an expired two-minute cloud open is dropped, so the 15-minute open behind it runs where v0.8.1\'s valve ignored it', {
  deviations: [
    { id: 'command-expiry', step: 0, field: 'decision', oracle: 'accepted', candidate: 'refused' },
    { id: 'command-expiry', step: 0, field: 'sent', oracle: true, candidate: false },
    { id: 'command-expiry', step: 0, field: 'frames', oracle: ['2:4102'], candidate: [] },
    { id: 'command-expiry', step: 0, field: 'expiry', oracle: [null], candidate: [] },
    { id: 'command-expiry', step: 2, field: 'delivered', oracle: '2:4102', candidate: '2:410F' },
    { id: 'command-expiry', step: 3, field: 'delivered', oracle: '2:410F', candidate: null },
    { id: 'command-expiry', step: 5, field: 'runs', oracle: [[5, 7]], candidate: [[5, 20]] },
    { id: 'command-expiry', step: 5, field: 'labels', oracle: ['manual', 'manual'], candidate: ['manual'] },
  ],
}, async (g) => {
  await g.cloud('OPEN_FOR_DURATION 2 min, expired one minute ago', { commandType: 'OPEN_FOR_DURATION', duration_minutes: 2, commandId: 'cloud-exp-7', expires_at: new Date(g.world.real - MINUTE).toISOString() });
  await g.open(15);
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
  g.wait(20 * MINUTE); await g.uplink();
});

// What stage 1 does not protect against, as v0.8.1 did not: nothing refuses the second open.
sequence('two opens 12 seconds apart, the OPEN uplink of the first run is not received: both run', { reportOnly: [severalFit()] }, async (g) => {
  await g.open(2);
  g.wait(12 * SECOND); await g.open(2);
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink({ report: 'lost' });
  g.wait(10 * MINUTE); await g.uplink();
  await watchRun(g, 2);
});

sequence('two opens 12 seconds apart, the valve reports its state change: the second is fetched during the run and ignored', {
  alsoCompare: ['history'],
  deviations: [{ id: 'run-history', step: 6, field: 'history', oracle: ['OBSERVED_COMPLETE', 'OBSERVED_COMPLETE'], candidate: ['PENDING_OBSERVATION', 'PENDING_OBSERVATION'] }],
  reportOnly: [severalFit()],
}, async (g) => {
  await g.open(2);
  g.wait(12 * SECOND); await g.open(2);
  g.wait(5 * MINUTE); await g.uplink();
  await watchRun(g, 2);
  g.wait(10 * MINUTE); await g.uplink();
});

// ------------------------------------------------------------------ cancel

// The cancelled open and the new one both fit the OPEN report. The gateway does not conclude
// from a reading of the queue that the cancelled open never reached the valve.
sequence('cancel before the valve fetched the open, then a new open', { reportOnly: [severalFit()] }, async (g) => {
  await g.open(15);
  g.wait(1 * MINUTE); await g.cancel();
  g.wait(1 * MINUTE); await g.open(15);
  g.wait(5 * MINUTE); await g.uplink();
  await watchRun(g, 15);
});

sequence('cancel after the valve fetched the open, then a new open that the running valve ignores', { reportOnly: [severalFit()] }, async (g) => {
  await g.open(15);
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(1 * MINUTE); await g.cancel();
  g.wait(1 * MINUTE); await g.open(15);
  g.wait(1 * MINUTE); await g.uplink();
  g.wait(15 * MINUTE); await g.uplink();
  g.wait(2 * MINUTE); await g.uplink();
});

// The cancel takes the open out and queues the setting and the CLOSE again, as v0.8.1 did.
sequence('cancel while a setting and a manual CLOSE are queued behind the open', {}, async (g) => {
  await g.open(15);
  await g.service('reporting interval', interval());
  await g.close();
  g.wait(1 * MINUTE); await g.cancel();
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(2 * MINUTE); await g.uplink();
});

sequence('cancel with nothing to cancel: before any command, right after a run, and after the monitor ran', {
  cancelErrors: { 0: 'no_active_actuation', 5: 'no_active_actuation', 6: 'no_active_actuation' },
  deviations: [
    { id: 'cancel-target', step: 5, field: 'decision', oracle: 'accepted', candidate: 'refused' },
    { id: 'cancel-target', step: 5, field: 'outcome', oracle: 'cancelled', candidate: 'not cancelled' },
    { id: 'cancel-target', step: 5, field: 'cancelAnswer', oracle: { http: 200, status: 'cancelled', confirmation: 'queue_flushed', cancelled: 1, previous_state: 'PENDING_OBSERVATION', reason: 'operator_cancel', chirpstack_queue_status: null, queue_scope: 'not_queued', dropped_opens: 0, message: null }, candidate: { http: 404, status: null, confirmation: null, cancelled: null, previous_state: null, reason: null, chirpstack_queue_status: null, queue_scope: null, dropped_opens: null, message: 'No active actuation to cancel' } },
  ],
}, async (g) => {
  await g.cancel();
  await g.open(2);
  g.wait(1 * MINUTE); await g.uplink();
  await watchRun(g, 2);
  await g.cancel();
  g.wait(2 * MINUTE); await g.ticks(); await g.cancel();
});

sequence('cancel while the valve runs the open, after the monitor ran', {}, async (g) => {
  await g.open(15);
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(1 * MINUTE); await g.ticks(); await g.cancel();
  g.wait(1 * MINUTE); await g.uplink();
  g.wait(15 * MINUTE); await g.uplink();
});

// A record that is still pending after its run must not make the cancel of a later open fail.
sequence('no time signal: a run is over, a new open is cancelled before the valve fetches it', { world: { ntp: false } }, async (g) => {
  await g.open(2);
  g.wait(1 * MINUTE); await g.uplink();
  await watchRun(g, 2);
  g.wait(5 * MINUTE); await g.ticks();
  await g.open(15);
  g.wait(1 * MINUTE); await g.cancel();
  g.wait(4 * MINUTE); await g.uplink();
  g.wait(1 * MINUTE); await g.uplink();
});

// v0.8.1 kept the first open active as well (its CLOSED report changed no state) and refused the
// cancel as ambiguous; the valve then ran the open the operator had tried to cancel. Unchanged.
sequence('the OPEN report of a run is not received, a new open is cancelled before the valve fetches it', {
  cancelErrors: { 5: 'ambiguous_actuation' },
  reportOnly: [severalFit('OBSERVED_RUNNING')], // the run of the open that could not be cancelled fits both pending records
}, async (g) => {
  await g.open(2);
  g.wait(1 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink({ report: 'lost' });
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(5 * MINUTE); await g.ticks();
  await g.open(15);
  g.wait(1 * MINUTE); await g.cancel();
  g.wait(4 * MINUTE); await g.uplink();
  g.wait(1 * MINUTE); await g.uplink();
});

// What v0.8.1's cancel does with the rest of the queue, kept: every other open is taken out as
// well and reported (dropped_opens), a flushing command is not queued again, a setting and a
// CLOSE are.
const queuedBehindTwoOpens = async (g) => {
  await g.open(15);
  await g.service('reporting interval', interval());
  await g.open(2);
  await g.service('flushing, return CLOSE', flushing('CLOSE'));
  await g.close();
  g.wait(1 * MINUTE);
};
sequence('a cancel that names its open, with two opens, a setting, a flushing command and a CLOSE queued', {}, async (g) => {
  await queuedBehindTwoOpens(g);
  await g.cancel({ open: 0 });
  await g.cancel({ open: 1 });
  for (let n = 0; n < 4; n += 1) { g.wait(2 * MINUTE); await g.uplink(); }
});

// The same queue and a cancel that names no open, as the control panel sends it: refused, as in
// v0.8.1 (#428: a cancel never picks a target nobody named), and both opens run.
sequence('a cancel that names no open, with two opens, a setting, a flushing command and a CLOSE queued', { cancelErrors: { 5: 'ambiguous_actuation' }, reportOnly: [severalFit()] }, async (g) => {
  await queuedBehindTwoOpens(g);
  await g.cancel();
  for (let n = 0; n < 6; n += 1) { g.wait(3 * MINUTE); await g.uplink(); }
});

// Two opens queued together produce one run whose report fits both; both records stay pending.
// Here they make the cancel of a third open ambiguous, and the valve runs the open the operator
// tried to cancel. v0.8.1 had ended both records on the CLOSED report and carried the cancel out.
sequence('two opens queued together have run once; a third open is cancelled without a name within the hour', {
  cancelErrors: { 7: 'ambiguous_actuation' },
  // The second record without a command is the run of the third open: it fits three records.
  reportOnly: [severalFit(), severalFit('OBSERVED_RUNNING')],
  deviations: [
    { id: 'cancel-target', step: 7, field: 'decision', oracle: 'accepted', candidate: 'refused' },
    { id: 'cancel-target', step: 7, field: 'outcome', oracle: 'cancelled', candidate: 'not cancelled' },
    { id: 'cancel-target', step: 7, field: 'cancelAnswer', oracle: { http: 200, status: 'cancelled', confirmation: 'queue_flushed', cancelled: 1, previous_state: 'PENDING_OBSERVATION', reason: 'operator_cancel', chirpstack_queue_status: 200, queue_scope: 'target_only', dropped_opens: 0, message: null }, candidate: { http: 409, status: null, confirmation: null, cancelled: null, previous_state: null, reason: null, chirpstack_queue_status: null, queue_scope: null, dropped_opens: null, message: 'More than one actuation is active; name the one to cancel (expectation_id)' } },
    { id: 'cancel-target', step: 7, field: 'queue', oracle: [], candidate: ['2:410F'] },
    { id: 'cancel-target', step: 8, field: 'delivered', oracle: null, candidate: '2:410F' },
    { id: 'cancel-target', step: 8, field: 'valve', oracle: 'CLOSED', candidate: 'OPEN' },
    { id: 'cancel-target', step: 9, field: 'reported', oracle: 'CLOSED', candidate: 'OPEN' },
    { id: 'cancel-target', step: 9, field: 'valve', oracle: 'CLOSED', candidate: 'OPEN' },
    { id: 'cancel-target', step: 9, field: 'shown', oracle: 'CLOSED', candidate: 'OPEN' },
    { id: 'cancel-target', step: 10, field: 'shown', oracle: 'CLOSED', candidate: 'OPEN' },
    { id: 'cancel-target', step: 10, field: 'runs', oracle: [[1.2, 3.2]], candidate: [[1.2, 3.2], [13.53, 'still open']] },
  ],
}, async (g) => {
  await g.open(2);
  g.wait(12 * SECOND); await g.open(2);
  g.wait(1 * MINUTE); await g.uplink();
  await watchRun(g, 2);
  g.wait(5 * MINUTE); await g.uplink(); await g.ticks();
  await g.open(15);
  g.wait(1 * MINUTE); await g.cancel();
  g.wait(4 * MINUTE); await g.uplink();
  g.wait(1 * MINUTE); await g.uplink();
});

// ------------------------------------------------------------------ F-4: service commands

sequence('F-4: service commands, each followed by an open, and the valve working through the queue', {}, async (g) => {
  await g.closeFor(2);
  await g.open(2);
  await g.service('timed close 2 min', timedClose(2));
  await g.open(2);
  await g.service('flushing, return CLOSE', flushing('CLOSE'));
  await g.open(2);
  await g.service('flushing, return OPEN', flushing('OPEN'));
  await g.open(2);
  await g.service('partial opening OPEN', partialOpening('OPEN'));
  await g.open(2);
  await g.service('reporting interval', interval());
  await g.open(2);
  g.wait(3 * DAY); await g.ticks();
  await g.open(2);
  await g.close();
  for (let n = 0; n < 14; n += 1) { g.wait(3 * MINUTE); await g.uplink(); }
});

// ------------------------------------------------------------------ the zone schedule the gateway scheduler runs

// Found by the council on #631 in the real runtime: with a soft-deleted schedule row on a live
// zone, the save fails on the unique constraint of irrigation_zone_id. v0.8.1 revived the row.
const schedulePatch = (threshold, minutes) => ({ trigger_metric: 'SWT_WM1', threshold_kpa: threshold, duration_minutes: minutes, enabled: 1, response_mode: 'proportional' });
sequence('saving a zone schedule: first save, a change, and a save on a zone that holds a soft-deleted schedule row', {}, async (g) => {
  await g.saveSchedule(schedulePatch(30, 15));
  g.wait(1 * MINUTE); await g.saveSchedule(schedulePatch(40, 20));
  g.wait(1 * MINUTE); await g.softDeleteSchedule();
  g.wait(1 * MINUTE); await g.saveSchedule(schedulePatch(25, 10));
  g.wait(1 * MINUTE); await g.saveSchedule(schedulePatch(35, 10));
});

// ------------------------------------------------------------------ F-3: upgrades

// Sol's finding 2 as a sequence: the old open has no queue expiry, so it runs when the valve
// returns, and so does the new one. v0.8.1 does the same without any upgrade.
const unfetchedOpenAtUpgrade = async (g) => {
  await g.open(2);
  g.wait(2 * DAY);
  await g.upgrade();
  await g.ticks();
  await g.open(2);
  g.wait(1 * HOUR); await g.uplink();
  await watchRun(g, 2);
  g.wait(5 * MINUTE); await g.uplink();
  await watchRun(g, 2);
};
const runningOpenAtUpgrade = async (g) => {
  await g.scheduler(30);
  g.wait(5 * MINUTE); await g.uplink();
  g.wait(20 * SECOND); await g.uplink();
  await g.service('reporting interval', interval());
  g.wait(2 * MINUTE);
  await g.upgrade();
  await g.ticks();
  await g.open(2);
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(30 * MINUTE); await g.uplink();
  g.wait(5 * DAY); await g.ticks();
  await g.open(2);
  await g.close();
  g.wait(2 * MINUTE); await g.uplink();
  g.wait(2 * MINUTE); await g.uplink();
};
for (const tag of ['v0.8.1', 'v0.8.0']) {
  const options = { oracle: () => ({ start: H.release(tag) }), candidate: upgradeFrom(tag) };
  // The valve returns an hour after the new open was handed over. The record of an open watches
  // for 31 minutes plus the run (the queue expiry 0.8.2 gave it, removed in stage 1), so the run
  // is booked without a command and both opens stay without an observation.
  sequence('F-3: upgrade from ' + tag + ' with an open the valve has not fetched', { ...options, reportOnly: [noCommand()] }, unfetchedOpenAtUpgrade);
  sequence('F-3: upgrade from ' + tag + ' with a run in progress and a queued setting', options, runningOpenAtUpgrade);
}

// Rows and owners a 0.8.2 gateway wrote: an open with an unqualified snapshot, an opaque owner of
// a service frame, a CLOSE owner. None of them refuses an ordinary command after the upgrade.
const leftBy082 = async (g) => {
  await g.open(2);
  await g.closeFor(2);
  await g.close();
  g.wait(3 * HOUR); await g.ticks();
  await g.upgrade();
  await g.ticks();
  await g.open(2);
  await g.scheduler(15);
  g.wait(1 * DAY); await g.ticks();
  await g.open(2);
  await g.close();
};
sequence('upgrade from 0.8.2 with its fenced open, service command and CLOSE left behind', { candidate: upgradeFrom082 }, leftBy082);

// What the upgrade cannot undo: frames 0.8.2 already queued keep the expiry 0.8.2 gave them. When
// the valve returns later than that, ChirpStack discards the old open and the old CLOSE.
test('frames a 0.8.2 gateway queued with an expiry are discarded when the valve returns late; frames queued after the upgrade are not', async (t) => {
  const run = await H.runSequence(t, upgradeFrom082(), {}, async (g) => {
    await leftBy082(g);
    for (let n = 0; n < 7; n += 1) { g.wait(10 * MINUTE); await g.uplink(); }
  });
  const uplinks = run.trace.filter((entry) => entry.op === 'valve uplink');
  assert.deepEqual(uplinks.flatMap((entry) => entry.discarded), ['2:4102', '1:30'], 'the open and the CLOSE that 0.8.2 queued with a 31-minute expiry');
  assert.deepEqual(uplinks.map((entry) => entry.delivered), ['2:4002', '2:4102', '2:410F', '2:4102', '1:30', null, null], 'the service frame of 0.8.2 (no expiry) and everything queued after the upgrade');
  assert.deepEqual(run.errors, []);
});

test('every declared deviation is used by a sequence', () => {
  assert.deepEqual(Object.keys(DEVIATIONS).filter((id) => !used.has(id)), []);
});
