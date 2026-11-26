import type {LogEvent} from '../core/log';
import type {ReplayHeader} from '../core/types';

/**
 * Written here, not by the core, so it has no `seq`. It follows the records a loaded replay rebuilt, which carry the
 * load's wall offset rather than the times they were first played (plan 7.6).
 */
interface ReplayLoad {sim_time: number; type: 'replay_load'; payload: {last_replayed_seq: number}}

export class LogExport {
  private readonly events: {record: LogEvent | ReplayLoad; offset: number}[] = [];
  private received = 0;

  constructor(private readonly header: ReplayHeader, private readonly startedAt: number) {}

  /** Core records received so far; the `replay_load` record is not one of them. */
  get sequence(): number { return this.received; }

  receive(records: readonly LogEvent[], now: number): void {
    const offset = Math.max(0, now - this.startedAt) / 1000;
    for (const record of records) this.events.push({record, offset});
    this.received += records.length;
  }

  /** Receives the records a loaded replay rebuilt and stamps a `replay_load` record after them. */
  replayLoad(records: readonly LogEvent[], simTime: number, now: number): void {
    this.receive(records, now);
    const lastSeq = records.length ? records[records.length - 1].seq : 0;
    this.events.push({
      record: {sim_time: simTime, type: 'replay_load', payload: {last_replayed_seq: lastSeq}},
      offset: Math.max(0, now - this.startedAt) / 1000,
    });
  }

  jsonl(sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('')): string {
    const {scenario, seed, build, tier} = this.header;
    return this.events.map(({record, offset}) => JSON.stringify({
      ...record, wall_offset_s: offset, session_id: sessionId, scenario, seed, build, tier,
    })).join('\n') + (this.events.length ? '\n' : '');
  }
}

export function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
