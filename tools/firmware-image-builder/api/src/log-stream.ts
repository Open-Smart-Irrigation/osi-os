import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const MAX_SSE_BYTES = 64 * 1024;
const O_CLOEXEC = (constants as typeof constants & { readonly O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC;
type StreamName = 'runner' | 'docker';
type MetadataEvent = 'enqueue' | 'cancellation_requested' | 'dispatch' | 'state' | 'stage' | 'operation' | 'container' | 'artifact' | 'publish' | 'terminal' | 'cleanup_admission' | 'cleanup_claim' | 'cleanup_renew' | 'cleanup_complete' | 'cleanup' | 'recovery' | 'freshness' | 'log-gap' | 'log-truncated';

export interface LogStreamEvent {
  readonly seq: number;
  readonly event: 'stage' | 'log' | 'terminal' | 'log-gap' | 'log-truncated';
  readonly data: Record<string, unknown>;
}

interface AppendResult {
  readonly seq: number;
  readonly stream: StreamName;
  readonly generation: number;
  readonly offset: number;
  readonly length: number;
  readonly partial: boolean;
}

export interface OrphanTailResult {
  readonly eventType: 'log_orphan_tail' | 'log-gap';
  readonly seq: number;
  readonly stream: StreamName;
  readonly generation: number;
  readonly offset: number;
  readonly length: number;
}

interface Options {
  readonly db: DatabaseSync;
  readonly root: string;
  readonly jobId: string;
  readonly now?: () => string;
  readonly beforeReplayRead?: (sourceSeq: number) => void;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function allBytes(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
}

function json(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export class DurableLogStream {
  readonly #db: DatabaseSync;
  readonly #jobId: string;
  readonly #now: () => string;
  readonly #beforeReplayRead?: (sourceSeq: number) => void;
  readonly #rootFd: number;
  #logsFd: number | null = null;
  #closed = false;

  constructor(options: Options) {
    if (process.platform !== 'linux' || typeof constants.O_DIRECTORY !== 'number' || typeof constants.O_NOFOLLOW !== 'number') {
      throw new Error('durable log streams require Linux no-follow descriptor support');
    }
    this.#db = options.db;
    this.#jobId = options.jobId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#beforeReplayRead = options.beforeReplayRead;
    this.#rootFd = openAbsoluteDirectoryNoFollow(options.root);
    try {
      this.#logsFd = openOptionalDirectoryChild(this.#rootFd, 'logs');
    } catch (error) {
      closeSync(this.#rootFd);
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#logsFd !== null) closeSync(this.#logsFd);
    closeSync(this.#rootFd);
  }

  appendSync(stream: StreamName, bytes: Uint8Array): AppendResult {
    if (bytes.byteLength === 0) throw new Error('log append must contain bytes');
    const generation = this.#openGeneration(stream);
    const row = this.#db.prepare('SELECT path, size_bytes FROM job_log_generations WHERE job_id=? AND stream=? AND generation=?').get(this.#jobId, stream, generation) as { path: string; size_bytes: number };
    const path = this.#generationPath(stream, generation, row.path, true);
    if (path === null) throw new Error('log directory could not be created');
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o640);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size !== Number(row.size_bytes)) throw new Error(`${stream} log is not a regular contiguous file`);
      allBytes(fd, bytes); fsyncSync(fd);
    } finally { closeSync(fd); }
    const offset = Number(row.size_bytes);
    const partial = bytes[bytes.byteLength - 1] !== 0x0a;
    let seq = -1;
    this.#transaction(() => {
      const next = this.#nextSeq();
      this.#db.prepare('UPDATE job_log_generations SET size_bytes=? WHERE job_id=? AND stream=? AND generation=?').run(offset + bytes.byteLength, this.#jobId, stream, generation);
      this.#db.prepare(`INSERT INTO job_events (job_id, seq, event_type, payload_json, at, stream, file_generation, byte_offset, byte_length, partial)
        VALUES (?, ?, 'log', ?, ?, ?, ?, ?, ?, ?)`).run(this.#jobId, next, json({ jobId: this.#jobId, stream, partial }), this.#now(), stream, generation, offset, bytes.byteLength, partial ? 1 : 0);
      seq = next;
    });
    return { seq, stream, generation, offset, length: bytes.byteLength, partial };
  }

  appendMetadataSync(event: MetadataEvent, data: Record<string, unknown>): number {
    let seq = -1;
    this.#transaction(() => {
      seq = this.#nextSeq();
      this.#db.prepare('INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, ?, ?, ?)').run(this.#jobId, seq, event, json(data), this.#now());
    });
    return seq;
  }

  sealSync(stream: StreamName): void {
    const row = this.#db.prepare('SELECT generation, path, size_bytes, sealed_at FROM job_log_generations WHERE job_id=? AND stream=? ORDER BY generation DESC LIMIT 1').get(this.#jobId, stream) as { generation: number; path: string; size_bytes: number; sealed_at: string | null } | undefined;
    if (!row || row.sealed_at !== null) return;
    const path = this.#generationPath(stream, Number(row.generation), row.path);
    if (path === null) throw new Error(`${stream} log directory is missing`);
    const bytes = readRegularFile(path);
    if (bytes.byteLength !== Number(row.size_bytes)) throw new Error(`${stream} log size diverged before seal`);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.#transaction(() => this.#db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=? AND stream=? AND generation=?').run(this.#now(), sha256, this.#jobId, stream, row.generation));
  }

  rotateSync(stream: StreamName): { readonly generation: number; readonly path: string } {
    this.sealSync(stream);
    const generation = this.#openGeneration(stream, true);
    const path = `logs/${stream}.${generation}`;
    return { generation, path };
  }

  sealOrphanTailSync(stream: StreamName, proof: { readonly unitInactive: boolean; readonly leaseStale: boolean; readonly noMatchingContainer: boolean }): OrphanTailResult {
    if (!proof.unitInactive || !proof.leaseStale || !proof.noMatchingContainer) throw new Error('orphan log sealing requires liveness proof');
    const row = this.#db.prepare('SELECT generation, path, size_bytes, sealed_at FROM job_log_generations WHERE job_id=? AND stream=? ORDER BY generation DESC LIMIT 1').get(this.#jobId, stream) as { generation: number; path: string; size_bytes: number; sealed_at: string | null } | undefined;
    if (!row) throw new Error('log generation does not exist');
    const path = this.#generationPath(stream, Number(row.generation), row.path);
    if (path === null) throw new Error(`${stream} log directory is missing`);
    const bytes = readRegularFile(path);
    const indexed = Number(row.size_bytes);
    if (bytes.byteLength < indexed) {
      return this.#persistOrphanGap(stream, Number(row.generation), bytes.byteLength, indexed - bytes.byteLength);
    }
    if (row.sealed_at !== null) {
      const existing = this.#orphanResult(stream, Number(row.generation));
      if (!existing) throw new Error('sealed generation has no orphan evidence');
      return existing;
    }
    const tailLength = bytes.byteLength - indexed;
    if (tailLength === 0) {
      this.sealSync(stream);
      return { eventType: 'log_orphan_tail', seq: -1, stream, generation: Number(row.generation), offset: indexed, length: 0 };
    }
    let seq = -1;
    this.#transaction(() => {
      const next = this.#nextSeq();
      this.#db.prepare('UPDATE job_log_generations SET size_bytes=? WHERE job_id=? AND stream=? AND generation=?').run(bytes.byteLength, this.#jobId, stream, row.generation);
      this.#db.prepare(`INSERT INTO job_events (job_id, seq, event_type, payload_json, at, stream, file_generation, byte_offset, byte_length, partial)
        VALUES (?, ?, 'log_orphan_tail', ?, ?, ?, ?, ?, ?, ?)`).run(this.#jobId, next, json({ jobId: this.#jobId, stream, generation: row.generation, offset: indexed, length: tailLength, partial: bytes[bytes.length - 1] !== 0x0a }), this.#now(), stream, row.generation, indexed, tailLength, bytes[bytes.length - 1] !== 0x0a ? 1 : 0);
      this.#db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=? AND stream=? AND generation=?').run(this.#now(), createHash('sha256').update(bytes).digest('hex'), this.#jobId, stream, row.generation);
      seq = next;
    });
    return { eventType: 'log_orphan_tail', seq, stream, generation: Number(row.generation), offset: indexed, length: tailLength };
  }

  replaySync(afterSeq: number): LogStreamEvent[] {
    const discoveredIdentities = new Map<number, FileIdentity>();
    for (const row of this.#eventRows(-1)) {
      if (row.stream === null || row.event_type === 'log-gap') continue;
      const seq = Number(row.seq);
      if (this.#sourceGap(seq)) continue;
      const stream = String(row.stream) as StreamName;
      const generation = Number(row.file_generation);
      const range = { offset: Number(row.byte_offset), length: Number(row.byte_length) };
      const generationRow = this.#db.prepare('SELECT path, size_bytes FROM job_log_generations WHERE job_id=? AND stream=? AND generation=?').get(this.#jobId, stream, generation) as { path: string; size_bytes: number } | undefined;
      if (!generationRow) {
        this.#gap(seq, stream, generation, range, 'GENERATION_MISSING');
        continue;
      }
      if (generationRow.path !== `logs/${stream}.${generation}`) {
        this.#gap(seq, stream, generation, range, 'GENERATION_PATH_MISMATCH');
        continue;
      }
      const path = this.#generationPath(stream, generation, generationRow.path);
      const identity = this.#rangeIdentity(path, range.offset, range.length);
      if (identity === null) this.#gap(seq, stream, generation, range, 'RANGE_UNREADABLE');
      else discoveredIdentities.set(seq, identity);
    }

    const output: LogStreamEvent[] = [];
    for (const row of this.#eventRows(afterSeq)) {
      const seq = Number(row.seq);
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      if (row.stream === null) {
        if (row.event_type === 'log-gap' && payload.sourceSeq !== undefined) {
          if (output.some((event) => event.event === 'log-gap' && event.data.sourceSeq === payload.sourceSeq)) continue;
          output.push({ seq, event: 'log-gap', data: payload });
        } else if (row.event_type === 'log-gap') output.push({ seq, event: 'log-gap', data: payload });
        else if (row.event_type === 'log-truncated') output.push({ seq, event: 'log-truncated', data: payload });
        else output.push({ seq, event: row.event_type === 'terminal' ? 'terminal' : 'stage', data: payload });
        continue;
      }
      if (this.#sourceGap(seq)) continue;
      const stream = String(row.stream) as StreamName;
      const generation = Number(row.file_generation);
      const range = { offset: Number(row.byte_offset), length: Number(row.byte_length) };
      const generationRow = this.#db.prepare('SELECT path, size_bytes FROM job_log_generations WHERE job_id=? AND stream=? AND generation=?').get(this.#jobId, stream, generation) as { path: string; size_bytes: number } | undefined;
      if (!generationRow || generationRow.path !== `logs/${stream}.${generation}`) continue;
      const path = this.#generationPath(stream, generation, generationRow.path);
      const expectedIdentity = discoveredIdentities.get(seq);
      if (path === null || expectedIdentity === undefined) {
        this.#gap(seq, stream, generation, range, 'READ_RACE');
        return this.replaySync(afterSeq);
      }
      this.#beforeReplayRead?.(seq);
      let bytes: Buffer;
      try {
        bytes = readRegularRange(path, range.offset, range.length, expectedIdentity);
      } catch (error) {
        if (isUnsafeAuthorityError(error)) throw error;
        this.#gap(seq, stream, generation, range, 'READ_RACE');
        return this.replaySync(afterSeq);
      }
      output.push({
        seq,
        event: 'log',
        data: {
          ...payload,
          jobId: this.#jobId,
          stream,
          generation,
          offset: range.offset,
          length: range.length,
          partial: Number(row.partial) === 1,
          bytesBase64: bytes.toString('base64'),
          ...validUtf8Text(bytes),
        },
      });
    }
    return output;
  }

  encodeSse(event: LogStreamEvent): string {
    let selected = event;
    let body = JSON.stringify(event.data);
    if (Buffer.byteLength(body) > MAX_SSE_BYTES - 64 && event.event === 'log') {
      selected = { seq: event.seq, event: 'log-truncated', data: { jobId: this.#jobId, stream: event.data.stream, generation: event.data.generation, offset: event.data.offset, length: event.data.length, partial: event.data.partial, truncated: true } };
      body = JSON.stringify(selected.data);
    }
    const frame = `id: ${selected.seq}\nevent: ${selected.event}\ndata: ${body}\n\n`;
    if (Buffer.byteLength(frame) > MAX_SSE_BYTES) throw new Error('SSE metadata exceeds 64 KiB');
    return frame;
  }

  keepalive(): string { return ': keepalive\n\n'; }

  async *keepaliveIterator(signal?: AbortSignal): AsyncGenerator<string> {
    while (!signal?.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 15_000);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (!signal?.aborted) yield this.keepalive();
    }
  }

  #openGeneration(stream: StreamName, forceNew = false): number {
    const row = this.#db.prepare('SELECT generation, sealed_at FROM job_log_generations WHERE job_id=? AND stream=? ORDER BY generation DESC LIMIT 1').get(this.#jobId, stream) as { generation: number; sealed_at: string | null } | undefined;
    if (row && row.sealed_at === null && !forceNew) return Number(row.generation);
    const generation = row ? Number(row.generation) + 1 : 0;
    this.#transaction(() => this.#db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at) VALUES (?, ?, ?, ?, ?)').run(this.#jobId, stream, generation, `logs/${stream}.${generation}`, this.#now()));
    return generation;
  }

  #generationPath(stream: StreamName, generation: number, persistedPath: string, createLogs = false): string | null {
    const expected = `logs/${stream}.${generation}`;
    if (persistedPath !== expected) throw new Error('log generation path does not match fixed generation identity');
    const logsFd = createLogs ? this.#ensureLogsDirectory() : this.#logsFd;
    return logsFd === null ? null : descriptorChild(logsFd, `${stream}.${generation}`);
  }

  #ensureLogsDirectory(): number {
    if (this.#logsFd !== null) return this.#logsFd;
    try {
      mkdirSync(descriptorChild(this.#rootFd, 'logs'), { mode: 0o750 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.#logsFd = openDirectoryChild(this.#rootFd, 'logs');
    return this.#logsFd;
  }

  #rangeIdentity(path: string | null, offset: number, length: number): FileIdentity | null {
    if (path === null) return null;
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new Error('log generation is not a regular file');
        return stat.size >= offset + length ? fileIdentity(stat) : null;
      } finally { closeSync(fd); }
    } catch (error) {
      if (isUnsafeAuthorityError(error)) throw error;
      return null;
    }
  }

  #nextSeq(): number { return Number((this.#db.prepare('SELECT COALESCE(MAX(seq)+1, 0) AS next FROM job_events WHERE job_id=?').get(this.#jobId) as { next: number }).next); }

  #eventRows(afterSeq: number): Array<Record<string, unknown>> {
    return this.#db.prepare(`SELECT seq, event_type, payload_json, at, stream, file_generation, byte_offset, byte_length, partial
      FROM job_events WHERE job_id=? AND seq>? ORDER BY seq`).all(this.#jobId, afterSeq) as Array<Record<string, unknown>>;
  }

  #sourceGap(sourceSeq: number): { readonly seq: number; readonly payload_json: string } | undefined {
    return this.#db.prepare("SELECT seq, payload_json FROM job_events WHERE job_id=? AND event_type='log-gap' AND json_extract(payload_json, '$.sourceSeq')=?").get(this.#jobId, sourceSeq) as { seq: number; payload_json: string } | undefined;
  }

  #transaction(work: () => void): void { this.#db.exec('BEGIN IMMEDIATE'); try { work(); this.#db.exec('COMMIT'); } catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* preserve primary error */ } throw error; } }

  #gap(seq: number, stream: StreamName, generation: number, range: { offset: number; length: number }, reason = 'RANGE_UNREADABLE'): LogStreamEvent {
    const existing = this.#sourceGap(seq);
    if (existing) return { seq: Number(existing.seq), event: 'log-gap', data: JSON.parse(existing.payload_json) as Record<string, unknown> };
    const data = { jobId: this.#jobId, code: 'RECOVERY_LOG_GAP', reason, sourceSeq: seq, stream, generation, offset: range.offset, length: range.length, path: `logs/${stream}.${generation}` };
    return this.#persistGap(seq, data);
  }

  #persistGap(sourceSeq: number, supplied: Record<string, unknown>): LogStreamEvent {
    const existing = this.#sourceGap(sourceSeq);
    if (existing) return { seq: Number(existing.seq), event: 'log-gap', data: JSON.parse(existing.payload_json) as Record<string, unknown> };
    const data = supplied;
    data.sourceSeq = sourceSeq;
    let gapSeq = -1;
    this.#transaction(() => { gapSeq = this.#nextSeq(); this.#db.prepare('INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, \'log-gap\', ?, ?)').run(this.#jobId, gapSeq, json(data), this.#now()); });
    return { seq: gapSeq, event: 'log-gap', data };
  }

  #persistOrphanGap(stream: StreamName, generation: number, offset: number, length: number): OrphanTailResult {
    const key = `orphan:${stream}:${generation}`;
    const existing = this.#db.prepare("SELECT seq, payload_json FROM job_events WHERE job_id=? AND event_type='log-gap' AND json_extract(payload_json, '$.orphanKey')=?").get(this.#jobId, key) as { seq: number; payload_json: string } | undefined;
    if (existing) { const data = JSON.parse(existing.payload_json) as Record<string, unknown>; return { eventType: 'log-gap', seq: Number(existing.seq), stream, generation, offset: Number(data.offset), length: Number(data.length) }; }
    const data = { jobId: this.#jobId, code: 'RECOVERY_LOG_GAP', stream, generation, offset, length, path: `logs/${stream}.${generation}`, orphanKey: key };
    let seq = -1;
    this.#transaction(() => { seq = this.#nextSeq(); this.#db.prepare("INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, 'log-gap', ?, ?)").run(this.#jobId, seq, json(data), this.#now()); });
    return { eventType: 'log-gap', seq, stream, generation, offset, length };
  }

  #orphanResult(stream: StreamName, generation: number): OrphanTailResult | undefined {
    const row = this.#db.prepare("SELECT seq, stream, file_generation, byte_offset, byte_length, event_type, payload_json FROM job_events WHERE job_id=? AND event_type='log_orphan_tail' AND stream=? AND file_generation=? ORDER BY seq DESC LIMIT 1").get(this.#jobId, stream, generation) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { eventType: row.event_type as 'log_orphan_tail' | 'log-gap', seq: Number(row.seq), stream, generation, offset: Number(row.byte_offset ?? JSON.parse(String(row.payload_json)).offset), length: Number(row.byte_length ?? JSON.parse(String(row.payload_json)).length) };
  }
}

function readRegularFile(path: string): Buffer { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = fstatSync(fd); if (!stat.isFile()) throw new Error('log generation is not a regular file'); fsyncSync(fd); const data = Buffer.alloc(stat.size); const read = readSync(fd, data, 0, stat.size, 0); if (read !== stat.size) throw new Error('short log read'); return data; } finally { closeSync(fd); } }
function readRegularRange(path: string, offset: number, length: number, expected: FileIdentity): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('log generation is not a regular file');
    if (!sameFileIdentity(fileIdentity(stat), expected)) throw new Error('log generation changed during replay');
    if (stat.size < offset + length) throw new Error('short log range');
    const data = Buffer.alloc(length);
    const read = readSync(fd, data, 0, length, offset);
    if (read !== length) throw new Error('short log range');
    return data;
  } finally { closeSync(fd); }
}

function fileIdentity(stat: ReturnType<typeof fstatSync>): FileIdentity {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    mode: Number(stat.mode),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function validUtf8Text(bytes: Uint8Array): { readonly text: string } | Record<string, never> {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return {};
  }
}

function isUnsafeAuthorityError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ELOOP'
    || (error instanceof Error && error.message.includes('not a regular file'));
}

function descriptorChild(parentFd: number, name: string): string {
  if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('log descriptor child is unsafe');
  }
  return `/proc/self/fd/${parentFd}/${name}`;
}

function openDirectoryChild(parentFd: number, name: string): number {
  return openSync(descriptorChild(parentFd, name), DIRECTORY_FLAGS);
}

function openOptionalDirectoryChild(parentFd: number, name: string): number | null {
  try {
    return openDirectoryChild(parentFd, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function openAbsoluteDirectoryNoFollow(path: string): number {
  let current = openSync('/', DIRECTORY_FLAGS);
  try {
    for (const segment of resolve(path).split('/').filter(Boolean)) {
      const next = openDirectoryChild(current, segment);
      closeSync(current);
      current = next;
    }
    return current;
  } catch (error) {
    closeSync(current);
    throw error;
  }
}
