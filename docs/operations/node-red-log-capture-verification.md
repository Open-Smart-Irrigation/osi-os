# Verifying Node-RED log capture on a gateway (issue #223)

**Status: NOT YET EXECUTED.** No gateway has run this recipe. It is written
against the change in `fix/node-red-init-log-capture` and is the operator half
of Task 3 in
[`docs/superpowers/plans/2026-09-12-boot-node-schema-safety.md`](../superpowers/plans/2026-09-12-boot-node-schema-safety.md).
Fill the evidence table below on the first run and drop the status line.

## What changed on the device

`feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` now does two
things it did not do before. The procd instance declares `stdout 1` and
`stderr 1`, so everything Node-RED writes — `node.error`, `node.warn`, an
uncaught throw in the boot node — goes to syslog instead of `/dev/null`. And
`ensure_persistent_syslog_sink()` points OpenWrt's own log service at
`/data/log/osi-system.log`, capped at 2048 KiB by `logread -S`, because syslog
on its own is logd's RAM ring and a power cycle empties it.

The sink is configured once. If `system.@system[0].log_file` already holds a
value, the function logs what it found and changes nothing, so an operator who
wants a different path or size sets those two UCI options by hand and this code
stays out of the way.

`deploy.sh` fetches the init script on every deploy and `chmod 755`es it
(`scripts/deploy-fetch-list.test.js` pins the path), so a flashed gateway takes
the change from the next ordinary deploy. No image rebuild, no extra on-device
step.

## When this may run

Never during a deploy window. The 2026-09-13 deploy train must be reported
finished on the host in question before any probe here starts. A probe restarts
Node-RED, and a restart in the middle of a payload swap corrupts the evidence
and possibly the deploy.

Uganda is production and was offline as of 2026-09-14. It needs Phil's explicit
go in the turn the probe runs, same as every other read against it. Silvan
first, then kaba100, then Uganda — the order the plan's rollout section sets.

## The recipe

Run after the first `deploy.sh` that carries this change.

### 1. The file on disk is the new one

```sh
grep -n 'procd_set_param std' /etc/init.d/node-red
grep -n 'ensure_persistent_syslog_sink' /etc/init.d/node-red
```

Two hits for the first, three for the second (the comment block, the definition,
the call in `start_service`). Fewer means the deploy did not replace the file;
stop and check the deploy log before going further.

### 2. The sink is configured and bounded

```sh
uci show system.@system[0] | grep -E 'log_file|log_size|log_buffer_size'
ls -l /data/log/
df -h /data
```

Expect `log_file='/data/log/osi-system.log'`, `log_size='2048'`, and
`log_buffer_size='64'`. The buffer value matters: `log.init` derives logd's RAM
ring from `log_size` when `log_buffer_size` is unset, so an unpinned buffer
would silently grow logd from 64 KiB to 2 MiB of RAM and restart it.

Worst case on disk is `osi-system.log` plus one rotated `osi-system.log.0`,
about 4 MiB. If `df` shows /data tight enough for 4 MiB to matter, that is a
disk-pressure finding in its own right — deal with it before the reboot in
step 4.

### 3. Output survives a service restart

```sh
/etc/init.d/node-red restart
sleep 20
logread | grep -i node-red | tail -20
tail -5 /data/log/osi-system.log
```

The pass signal is any Node-RED line in both outputs. An empty `logread` result
after a restart means the deployed init is not the new one; go back to step 1.

### 4. Output survives a reboot

This is the half that `procd_set_param stdout/stderr` alone does not give, and
the reason #223 stayed open. Note a distinctive line from step 3 first, then:

```sh
reboot
# wait for the gateway to come back, then:
logread | grep -i node-red | head -5
grep -c node-red /data/log/osi-system.log
grep '<the line noted in step 3>' /data/log/osi-system.log
```

`logread` starts empty-ish because the ring was lost; the file must still hold
the pre-reboot line. If it does not, the sink is not working and #223 is not
closed regardless of what steps 1 to 3 showed.

### 5. The ring is not being flooded

An hour after the restart:

```sh
logread | wc -l
wc -c /data/log/osi-system.log
```

Compare against the plan's stop condition: if Node-RED dominates the ring, add
rate limiting before rolling to the next gateway rather than reverting the
capture.

## Evidence

| Gateway | Date | Steps 1-2 | Step 3 | Step 4 | Step 5 growth | Operator |
|---|---|---|---|---|---|---|
| Silvan | | | | | | |
| kaba100 | | | | | | |
| Uganda | | | | | | |

Paste the verbatim command output into the PR that closes #223, not only the
pass/fail marks in this table.
