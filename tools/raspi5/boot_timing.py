"""Boot-phase timing from a guest's syslog: what a slow boot spent its time on.

After an API wait past SLOW_API_SECONDS the harness keeps three things for the
case (upgrade_suite.wait_for_api calls keep): the phase lines of this boot that
it read from the guest's persistent syslog, their timing, and a one-line summary
on the case's results line. By hand, on a kept log:

    python3 boot_timing.py SYSLOG [--api-answer "Sun Apr 13 16:51:09 2025"] [--json]

A syslog carries no request log. The first /api/me answer therefore comes from
the API wait, which prints the guest clock at the first 401; read without it,
a log reports the answer as absent.

Where a boot begins in a log: the last place the guest clock goes backwards,
date and time both. The emulator's clock restarts at the kernel's build time in
every boot, so the first line of a boot is earlier than the last line of a boot
that lived past it. A boot cut before its clock came that far left no phase
lines, so a log without such a place is read whole. A run that ends after that
place is still this boot's, with whatever span its lines give: one that goes
backwards is "unknown (clock step)", never a day. A run whose start was not
read (a Node-RED palette load without its start line) stays in the output and
says so.
"""
import argparse
from datetime import date
import json
from pathlib import Path
import re
import sys

from suite_vm import note_wait

# An API wait longer than this keeps the boot's phase timing. The Pi 5 budget
# (420 s) never reaches it on a pass; the Pi 4's (900 s) can.
SLOW_API_SECONDS = 600
# The persistent syslog sink node-red.init keeps on /data. logd renames it to
# .old once it passes its size and starts a new file with the same name.
SYSLOG = '/data/log/osi-system.log'
READ_SECONDS = 300
# Lines before the console's checkpoint that the read still takes. The boot may
# have written before the console answered; its first line is what the read
# needs, and the checkpoint alone can already be past it.
LOOKBACK = 2000
CLOCK_STEP = 'unknown (clock step)'

# The wall clock logd puts on every line.
STAMP = re.compile(r'^[A-Z][a-z][a-z] (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d+) '
                   r'(\d\d):(\d\d):(\d\d) (\d{4}) ')
MONTHS = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')
WEEKDAYS = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')
BOOTSTRAP_START = re.compile(r' osi-bootstrap: waiting for ChirpStack gRPC\.\.\.')
# The last line osi-bootstrap logs in a boot, whichever way its run went.
BOOTSTRAP_DONE = re.compile(r' osi-bootstrap: (?:Node-RED restart re|identityd is not ready|bootstrap completed but'
                            r'|bootstrap failed|ChirpStack not ready)')
# First-boot work besides the bootstrap: the LoRaWAN device import, which
# arrives through procd's rc.d runner.
DEVICE_IMPORT = re.compile(r'procd: /etc/rc\.d/S99zzz-lorawan-devices\.init: ')
NODE_RED = re.compile(r' node\[(\d+)\]: (?:\d\d \w{3} \d\d:\d\d:\d\d - \[info\] )?'
                      r'(Welcome to Node-RED|Loading palette nodes|Settings file|Server now running at)')
# Node-RED logs "Settings file" first once its palette nodes are loaded, and
# "Server now running" when /api/me can answer.
NODE_RED_STEPS = {'Welcome to Node-RED': 'started', 'Loading palette nodes': 'node_load_start',
                  'Settings file': 'node_load_end', 'Server now running at': 'listening'}
CLOCKED = ('started', 'node_load_start', 'node_load_end', 'listening')

# What a read_script() output carries besides syslog lines.
HEADER = 'osi-harness: '
READ = re.compile(r'^osi-harness: boundary (\d+) of (\d+) lines read(?:, (.*) to (.*))?$')
NUMBERED = re.compile(r'^(\d+) (.*)$')

# Guest awk. The shell's own header lines pass through and are not counted. The
# device import writes thousands of lines through procd's runner, too many for
# the console: every phase line comes through once with its number among the
# lines read, and of each run of import lines the first and the last.
# The last line says where the boot begins, by the full date and time, so that
# midnight under a continuous clock is no boundary.
AWK = r"""function stamp(line,   f, n, m) {
    n = split(line, f, " ")
    if (n < 5 || f[1] !~ /^[A-Z][a-z][a-z]$/ || f[3] !~ /^[0-9]+$/ || f[4] !~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/ || f[5] !~ /^[0-9][0-9][0-9][0-9]$/) return ""
    m = index("JanFebMarAprMayJunJulAugSepOctNovDec", f[2])
    if (m % 3 != 1) return ""
    return f[1] " " f[2] " " f[3] " " f[4] " " f[5]
}
function key_of(text,   f, m) {
    split(text, f, " ")
    m = index("JanFebMarAprMayJunJulAugSepOctNovDec", f[2])
    return f[5] * 10000000000 + ((m + 2) / 3) * 100000000 + f[3] * 1000000 + substr(f[4], 1, 2) * 3600 + substr(f[4], 4, 2) * 60 + substr(f[4], 7, 2)
}
/^osi-harness: / { print; next }
{ n++; s = stamp($0); if (s != "") { if (first == "") first = s; last = s; k = key_of(s); if (k < prev) boot = n; prev = k } }
/S99zzz-lorawan-devices\.init: / { if (!seen) { print n " " $0; seen = 1 } else { ilpos = n; illine = $0; pending = 1 }; next }
/osi-bootstrap|S99osi-bootstrap|Welcome to Node-RED|Loading palette nodes|Settings file|Server now running/ { if (pending) { print ilpos " " illine; pending = 0 }; print n " " $0 }
END {
    if (pending) print ilpos " " illine
    print "osi-harness: boundary " boot + 0 " of " n " lines read" (first == "" ? "" : ", " first " to " last)
}"""


def read_script(first_line, inode):
    """Guest shell that prints the phase lines of the guest's syslog, each with its number among the lines read.

    The file is the one the console's probe found (Guest.LOG_CHECKPOINT): the
    lines from `first_line` on, and the LOOKBACK lines before them. logd rotates
    the file by renaming it to .old, so its inode (`inode`), not its line count,
    says whether that happened since the console answered: a busy new file can
    have passed the old count. A guest without a persistent syslog is read from
    the boot's ring. The image's BusyBox has no stat; ls -i gives the inode.
    """
    syslog, rotated = SYSLOG, SYSLOG + '.old'
    start = max(1, first_line - LOOKBACK + 1)
    return (
        f'{{ f="{syslog}"; o="{rotated}"; I="{inode}"\n'
        '  id() { set -- $(ls -i "$1" 2>/dev/null); echo "$1"; }\n'
        '  if [ -z "$I" ]; then\n'
        '    echo "osi-harness: no persistent syslog when the console answered"\n'
        '    if [ -f "$f" ] || [ -f "$o" ]; then cat "$o" "$f" 2>/dev/null; else logread; fi\n'
        '  elif [ "$(id "$f")" = "$I" ]; then\n'
        '    echo "osi-harness: syslog: the file the console found"\n'
        f'    tail -n +{start} "$f"\n'
        '  elif [ "$(id "$o")" = "$I" ]; then\n'
        '    echo "osi-harness: syslog: rotated once since the console"\n'
        f'    tail -n +{start} "$o"; cat "$f"\n'
        '  else\n'
        '    echo "osi-harness: syslog: rotated past the file the console found"\n'
        '    cat "$o" "$f" 2>/dev/null\n'
        '  fi\n'
        f'}} | awk \'{AWK}\'\n')


def line_time(line):
    """The guest's wall clock on a syslog line, date and time, in seconds; None for a line without one."""
    found = STAMP.match(line)
    if not found:
        return None
    try:
        day = date(int(found[6]), MONTHS.index(found[1]) + 1, int(found[2])).toordinal()
    except ValueError:
        return None
    return day * 86400 + int(found[3]) * 3600 + int(found[4]) * 60 + int(found[5])


def clock(seconds):
    """A wall clock in seconds as the syslog writes it: 'Sun Apr 13 16:42:19 2025'."""
    day, rest = divmod(seconds, 86400)
    hour, rest = divmod(rest, 3600)
    day = date.fromordinal(day)
    return (f'{WEEKDAYS[day.weekday()]} {MONTHS[day.month - 1]} {day.day:2d} '
            f'{hour:02d}:{rest // 60:02d}:{rest % 60:02d} {day.year:04d}')


def time_of_day(stamp):
    return stamp[11:19]


def span(start, end):
    """A phase: the guest clock at both ends (None where it was not read) and its length.

    The length is None where an end is missing, and CLOCK_STEP where the clock
    went backwards between the two ends.
    """
    return {'start': None if start is None else clock(start),
            'end': None if end is None else clock(end),
            'seconds': None if start is None or end is None else (end - start if end >= start else CLOCK_STEP)}


def _read(log):
    """(numbered lines, size, first and last clock, boundary, note) of a syslog or of a read_script() output.

    Numbered lines are (position, clock, line) for every line with a clock, the
    position counting all lines. The boundary is the last position where the
    clock is earlier than on the line before it; None where there is none.
    """
    rows = log.splitlines()
    if not any(row.startswith(HEADER) for row in rows):
        timed = [(n, at, row) for n, row in enumerate(rows, 1) if (at := line_time(row)) is not None]
        return (timed, len(rows), clock(timed[0][1]) if timed else None, clock(timed[-1][1]) if timed else None,
                _boundary(timed), None)
    timed, size, first, last, boundary, note = [], 0, None, None, None, None
    for row in rows:
        if row.startswith(HEADER):
            read = READ.match(row)
            if read:
                size, boundary, first, last = int(read[2]), int(read[1]) or None, read[3], read[4]
            else:
                note = row[len(HEADER):].removeprefix('syslog: ')
            continue
        numbered = NUMBERED.match(row)
        if numbered and (at := line_time(numbered[2])) is not None:
            timed.append((int(numbered[1]), at, numbered[2]))
    return timed, size, first, last, boundary, note


def _boundary(timed):
    """The last position at which the clock is earlier than on the timed line before it."""
    found = None
    for (_, previous, _), (where, at, _) in zip(timed, timed[1:]):
        if at < previous:
            found = where
    return found


def boot_phases(log, api_answer=None):
    """Timing of one boot's phases, from its syslog lines or from what read_script() read.

    The boot begins at the last place the guest clock goes backwards; runs that
    ended before it belong to an earlier boot and are left out. Each phase is
    taken from its last run. A phase the log does not finish has no end, and a
    run whose start the log lacks says so. `api_answer` is the guest clock the
    API wait printed at the first 401.
    """
    timed, size, first, last, boundary, note = _read(log)
    in_boot = lambda where: boundary is None or where >= boundary
    boots, imports, runs = [], [], []
    for where, at, line in timed:
        if BOOTSTRAP_START.search(line):
            boots.append({'where': where, 'start': at, 'end_where': None, 'end': None})
        elif BOOTSTRAP_DONE.search(line):
            # A run never ends in a later boot than it began: the init logs its
            # start before it runs the script. So the end closes the open run.
            if boots and boots[-1]['end'] is None:
                boots[-1].update(end_where=where, end=at)
            else:
                boots.append({'where': where, 'start': None, 'end_where': where, 'end': at})
        if DEVICE_IMPORT.search(line):
            imports.append({'where': where, 'start': at, 'end_where': where, 'end': at})
        found = NODE_RED.search(line)
        if not found:
            continue
        step, pid = NODE_RED_STEPS[found[2]], found[1]
        if step == 'started':
            runs.append({'pid': pid, 'where': where, 'started': at, 'node_load_start': None,
                         'node_load_end': None, 'listening': None})
            continue
        # A pid number comes back on the next boot: lines join a run only within the boot.
        run = next((run for run in reversed(runs)
                    if run['pid'] == pid and in_boot(run['where']) and run[step] is None), None)
        if run is None:
            run = {'pid': pid, 'where': where, 'started': None, 'node_load_start': None,
                   'node_load_end': None, 'listening': None}
            runs.append(run)
        run[step], run['where'] = at, where
    imports = [entry for entry in imports if in_boot(entry['where'])]
    if imports:
        imports[0]['end'], imports[0]['end_where'] = imports[-1]['end'], imports[-1]['end_where']
    boots = [run for run in boots if in_boot(run['end_where'] or run['where'])]
    runs = [run for run in runs if in_boot(run['where'])]
    bootstrap = boots[-1] if boots else None
    work = [entry for entry in (bootstrap, imports[0] if imports else None) if entry is not None]
    first_boot_work = None
    if work:
        starts = [entry['start'] for entry in work if entry['start'] is not None]
        ends = [entry['end'] for entry in work if entry['end'] is not None]
        first_boot_work = span(min(starts) if starts else None, max(ends) if ends else None)
    for run in runs:
        run['node_load_seconds'] = span(run['node_load_start'], run['node_load_end'])['seconds']
    answer = line_time(api_answer + ' ') if api_answer else None
    return {
        'log': {'lines': size, 'first': first, 'last': last, 'boundary': boundary, 'read': note},
        'first_boot_work': first_boot_work,
        'osi_bootstrap': span(bootstrap['start'], bootstrap['end']) if bootstrap else None,
        'device_import': span(imports[0]['start'], imports[0]['end']) if imports else None,
        'node_red': [{key: clock(value) if key in CLOCKED and value is not None else value
                      for key, value in run.items() if key != 'where'} for run in runs],
        'api_answer': clock(answer) if answer is not None else None,
    }


def spanned(name, phase):
    """One line for a phase: both ends and its length, or what the log leaves of it."""
    start, end, seconds = (phase[key] for key in ('start', 'end', 'seconds'))
    if start is None:
        return f'{name}: ended {time_of_day(end)}, start not in this log'
    if seconds == CLOCK_STEP:
        return f'{name}: {time_of_day(start)} to {time_of_day(end)} (unknown: clock step)'
    if end is None:
        return f'{name}: {time_of_day(start)}, not finished in this log'
    return f'{name}: {time_of_day(start)} to {time_of_day(end)} ({seconds} s)'


def format_phases(phases):
    """The timing as receipt lines: times of day; the first line has the dates."""
    log, work = phases['log'], phases['first_boot_work']
    first = f'{log["first"]} to {log["last"]}' if log['first'] else 'no line with a clock'
    lines = [f'guest syslog: {log["lines"]} lines, {first}'
             + (f'; the boot begins at line {log["boundary"]}' if log['boundary'] else ''),
             'first-boot work: none in this log' if work is None else spanned('first-boot work', work)]
    if work is not None:
        lines += ['  ' + ('osi-bootstrap: none in this log' if phases['osi_bootstrap'] is None
                          else spanned('osi-bootstrap', phases['osi_bootstrap'])),
                  '  ' + ('device import: none in this log' if phases['device_import'] is None
                          else spanned('device import', phases['device_import']))]
    for run in phases['node_red']:
        head = f'started {time_of_day(run["started"])}' if run['started'] is not None else 'start not in this log'
        began, ended, seconds = run['node_load_start'], run['node_load_end'], run['node_load_seconds']
        if began is None and ended is None:
            load = 'node load not begun in this log'
        elif ended is None:
            load = f'node load from {time_of_day(began)}, not finished in this log'
        elif began is None:
            load = f'node load ended {time_of_day(ended)}, its start not in this log'
        elif seconds == CLOCK_STEP:
            load = f'node load {time_of_day(began)} to {time_of_day(ended)} (unknown: clock step)'
        else:
            load = f'node load {time_of_day(began)} to {time_of_day(ended)} ({seconds} s)'
        listening = f', API listening {time_of_day(run["listening"])}' if run['listening'] is not None else ''
        lines.append(f'Node-RED {run["pid"]}: {head}, {load}{listening}')
    if not phases['node_red']:
        lines.append('Node-RED: no start in this log')
    answer = phases['api_answer']
    lines.append('first /api/me answer: none in this evidence' if answer is None
                 else f'first /api/me answer: {time_of_day(answer)} (guest clock, read by the API wait)')
    return '\n'.join(lines)


def summarize(phases):
    """One line, for the results line of the case."""
    parts = []
    work = phases['first_boot_work']
    if work is None:
        parts.append('no first-boot work in the log')
    else:
        parts.append('first-boot work ' + _extent(work))
    for name, key in (('osi-bootstrap', 'osi_bootstrap'), ('device import', 'device_import')):
        if phases[key] is not None:
            parts.append(f'{name} {_length(phases[key])}')
    if not phases['node_red']:
        parts.append('Node-RED did not start in the log')
    for run in phases['node_red']:
        head = f'Node-RED {run["pid"]}' if run['started'] is not None else f'Node-RED {run["pid"]} start not in the log,'
        parts.append(f'{head} node load {_length(run, "node_load_start", "node_load_end", "node_load_seconds")}')
    answer = phases['api_answer']
    parts.append('no first /api/me answer' if answer is None else f'first /api/me answer {time_of_day(answer)}')
    read = phases['log']['read']
    summary = ', '.join(parts)
    if read not in (None, 'the file the console found'):
        summary += f'; syslog {read}'
    return summary


def _length(phase, start_key='start', end_key='end', seconds_key='seconds'):
    """How long a phase took, or what the log leaves of it; `phase` may hold its ends under other keys."""
    start, end, seconds = phase[start_key], phase[end_key], phase[seconds_key]
    if start is None:
        return 'not read' if end is None else f'ended {time_of_day(end)}' + (
            ', start not in the log' if start_key == 'start' else '')
    if seconds == CLOCK_STEP:
        return 'unknown (clock step)'
    if end is None:
        return 'not finished'
    return f'{seconds} s'


def _extent(work):
    """The first-boot work on a summary line: from where it began to where it ended, or what is missing."""
    start, end, seconds = work['start'], work['end'], work['seconds']
    if start is None:
        return f'ended {time_of_day(end)}, start not in the log'
    if seconds == CLOCK_STEP:
        return f'{time_of_day(start)} to {time_of_day(end)}, unknown (clock step)'
    if end is None:
        return f'{time_of_day(start)}, not finished'
    return f'{time_of_day(start)} to {time_of_day(end)}'


def keep(vm, answer):
    """After a slow API wait: keep this boot's phases in the case receipts and on its results line.

    Nothing here may fail the wait that passed: a guest that cannot be read, or
    a receipt that cannot be written, is said on the results line instead.
    """
    if vm.private:
        return
    # Here, not at the top: upgrade_suite imports this module.
    from upgrade_suite import checked
    try:
        read = checked(vm, read_script(vm.log_from + 1, vm.log_inode), READ_SECONDS)
        (vm.receipts/f'boot-timing-{vm.boots}.syslog').write_text(read + '\n')
        phases = boot_phases(read, answer)
        (vm.receipts/f'boot-timing-{vm.boots}.txt').write_text(format_phases(phases) + '\n')
    except Exception as error:
        note_wait(vm, f'boot timing not kept: {error!r}')
        return
    # keep() runs only after a passed wait, so the API did answer.
    note_wait(vm, 'boot timing: ' + summarize(phases)
              + ('' if phases['api_answer'] else '; the API wait printed no guest clock'))


def main(argv=None):
    parser = argparse.ArgumentParser(description='Boot-phase timing from a guest syslog.')
    parser.add_argument('syslog', type=Path)
    parser.add_argument('--api-answer', help='the guest clock the API wait printed at the first 401')
    parser.add_argument('--json', action='store_true', help='print the phases as JSON')
    args = parser.parse_args(argv)
    phases = boot_phases(args.syslog.read_text(errors='replace'), args.api_answer)
    print(json.dumps(phases, indent=2) if args.json else format_phases(phases))
    return 0


if __name__ == '__main__':
    sys.exit(main())
