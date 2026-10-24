# Conditional irrigation

Software route and fixture checks are complete. Physical qualification is **NOT
RUN**, and production qualification remains **false**. Browser fixtures do not
change that gate.

## Set a condition and a time

A condition decides whether a scheduled opportunity waters. It never starts
irrigation immediately when a sensor crosses its threshold. Select existing
schedules, or choose a daily start time when no schedule is selected. The policy
timezone controls these checks and the daily allowance. Each selected schedule
keeps its own duration.

SWT offers Wet (20 kPa), Moist (30 kPa), Dry (50 kPa), and Custom. The Moist help
contains “Recommended”. These are irrigation preferences; a current soil-status
label can use different boundaries. A saved custom threshold retains its precision.
VWC requires an explicit percentage and selected sensor channels. Zero is a valid
threshold; an empty field is incomplete. Keep unavailable selected sources visible
until the farmer explicitly changes them.

Dendrometer conditions support fixed and proportional duration. Conversion from
the legacy trigger changes hold and below-threshold days to skipped irrigation;
legacy watering could still use the base duration. The conversion preview must
show that change and the legacy run time in the policy timezone. That preview
uses the gateway process timezone, not the browser timezone.

The policy defaults are a 60-minute observation window, a 60-minute minimum
interval, and a 240-minute daily allowance. Each valve has its own delivery
interval in `delivery_settings`; inspect the saved value before changing a
plan. These policy intervals do not change a device's uplink cadence.

## Conversion and readiness

Conversion saves the policy and asks each valve to clear its existing fixed
program. Automatic dispatch waits for every required clear acknowledgement and
the remaining clock, evidence, incident and qualification checks. An ACK means
the software matched a reply; it does not prove the valve physically cleared
its program. Gen1 and Gen2 require separate bench evidence.

The clear frames are generation-specific. Gen1 clears each weekday with its
all-`FF` frame and receives weekday replies on scheduler ports 14 through 20.
Gen2 clears the program with the one-byte `0x80` frame and receives the day-mask
reply on ACK port 25 (including the documented raw-byte fallback). Scheduler
status uses port 21; clock replies use RTC ports 12 and 13. Store the raw reply,
revision, queue result, and physical observation for every clear.

A rejected conversion preserves the draft. Correct the reported schedule, timezone,
daily allowance, or gap conflict before saving again. Attached schedule timezones
must match the policy timezone. Changing the zone timezone does not silently
reinterpret an existing policy.

`Pause` disables future policy decisions and handles pending commands through the
existing safety path. `Disable all` retires policy authority for the zone and
prevents due dispatch after a restart. Neither action claims that a valve is
closed, restores fixed schedules, or clears an active run. Converting back to
Always explicitly restores ordinary fixed scheduling through the normal plan
push. A retry requests a new clear revision; it does not bypass unresolved
watering or prove physical delivery.

Treat a command as **PENDING** until the gateway applies it. Treat a policy as
**BLOCKED** when a trusted clock, fresh source evidence, qualification, clear
ACK, incident state, or active-run safety check is missing. Leave the reason and
request identity visible, resolve that reason, then retry. Do not use a retry to
turn a blocked or rejected command into an assumed delivery.

## Read results

The gateway checks opportunities on its 60-second tick. It may decide a slot up to
10 minutes late, inclusive. Later slots are recorded as skipped with missed_start;
outages do not cause catch-up watering. A nonexistent daylight-saving time is
skipped, and a repeated local time is checked only once.

Use the last decision and per-valve status to distinguish a false condition, missing
evidence, an untrusted clock, a pending program update, a recent run, a daily limit,
or unexpected watering. Keep command acceptance, observed valve state and physical
measurement separate. Missing endpoint reports leave uncertainty visible.

An unexpected valve-scheduled open blocks further conditional dispatch and consumes
the applicable allowance. Investigate the old program or external control before
retrying. A successful clear alone does not erase an unresolved active run.

## Cloud edits and compatibility

Cloud saves remain pending until the gateway applies them. The cloud does not
evaluate conditions or start conditional irrigation independently. A retry of the
same submitted action retains its request identity; a new deliberate action gets
a new identity. Rejected edits remain available while the editor stays mounted.

Read cloud state before edge state during a release. Deploy the compatible cloud
reader first, confirm that it preserves pending and rejected responses, then
deploy the edge reader and runtime. This avoids an edge command arriving before
the cloud can represent its result. A downgrade follows the same order in
reverse after pending work is settled or explicitly blocked.

Conditional policies and schedules are omitted as whole resources for unsupported
servers. They are never sent as ordinary fixed schedules. Supported sync requests
use guarded endpoints; a 404 or 503 does not fall back to a legacy endpoint.
Local policies can continue when replication support disappears, while new cloud
edits remain unavailable.

For an old peer, keep the local policy and report unsupported capability. Do not
translate it into an ordinary fixed schedule. During downgrade, preserve the
ordered migration ledger and customer database; never replace a provisioned
database with a seed. Resume only after the peer reports the required policy
capability again.

## Release evidence

Record the final paired software commits, migration checksums, browser results and
software test logs in the execution report. Use a separate bench record for the
following physical evidence; every row currently remains **NOT RUN**:

| Check | Required record |
| --- | --- |
| Clear and ACK | Gen1's seven all-`FF` weekday clears, Gen2's `0x80` clear, raw replies, exact firmware/profile, and physical absence of the old program |
| Expiry and latency | Queue cutoff, radio outage/reconnect, due-to-enqueue and enqueue-to-observed-open p95/max/count, and delayed ACK handling |
| Clock and power loss | Real NTP callback, synchronization marker, boot identity, reboot around reservation/send, and no duplicate OPEN |
| Physical effect | At least 20 opens per generation, including short runs, lost endpoint uplinks, and a CLOSE near expiry; measure selection-to-open ≤ B and selection-to-final-CLOSED/no-flow ≤ B+D |
| External actuation | Magnet, Bluetooth, or digital-input opens, sticky incident, one run charge, and blocked automatic dispatch |
| Qualification identity | Captured current firmware/profile match, registry revocation or absence, and rejection of unqualified identities |

ACK readiness proves only that the software matching rule passed. The nonce-free
protocol permits a delayed reply to be assigned to a later revision. It does not
prove radio delivery or physical clearing. Mocked qualification is test input
only; the production provider defaults to false until the identity and bench
evidence are accepted.

Preserve customer data through ordered migrations; never replace a provisioned
gateway database with a seed. Production activation also requires a reliable
firmware identity and matching qualification registry, which this implementation
does not establish.
