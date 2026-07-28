import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const MAX_SSE_BYTES = 64 * 1024;
const DEFAULT_REPLAY_EVENT_LIMIT = 256;
const MAX_REPLAY_EVENT_LIMIT = 1_000;
const DEFAULT_REPLAY_DECODED_BYTES = 512 * 1024;
const MAX_REPLAY_DECODED_BYTES = 16 * 1024 * 1024;
const HASH_BUFFER_SIZE = 64 * 1024;
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
  readonly eventType: 'sealed' | 'log_orphan_tail' | 'log-gap';
  readonly seq: number;
  readonly stream: StreamName;
  readonly generation: number;
  readonly offset: number;
  readonly length: number;
}

export interface ReplayLimits {
  readonly eventLimit?: number;
  readonly maxDecodedBytes?: number;
}

export interface LogStreamIo {
  readonly readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  readonly writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number) => number;
  readonly fsyncSync: (fd: number) => void;
}

interface Options {
  readonly db: DatabaseSync;
  readonly root: string;
  readonly jobId: string;
  readonly now?: () => string;
  readonly beforeReplayRead?: (sourceSeq: number) => void;
  readonly io?: Partial<LogStreamIo>;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface SourceCoordinates {
  readonly seq: number;
  readonly stream: StreamName;
  readonly generation: number;
  readonly range: {
    readonly offset: number;
    readonly length: number;
  };
}

function allBytes(fd: number, bytes: Uint8Array, write: LogStreamIo['writeSync']): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = write(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error('log write made zero progress');
    if (written > bytes.byteLength - offset) throw new Error('log write reported invalid progress');
    offset += written;
  }
}

function json(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function replayLimits(afterSeq: number, requested: ReplayLimits): { readonly eventLimit: number; readonly maxDecodedBytes: number } {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw new Error('replay cursor must be a safe integer at least -1');
  const eventLimit = requested.eventLimit ?? DEFAULT_REPLAY_EVENT_LIMIT;
  if (!Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > MAX_REPLAY_EVENT_LIMIT) {
    throw new Error(`replay event limit must be between 1 and ${MAX_REPLAY_EVENT_LIMIT}`);
  }
  const maxDecodedBytes = requested.maxDecodedBytes ?? DEFAULT_REPLAY_DECODED_BYTES;
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1 || maxDecodedBytes > MAX_REPLAY_DECODED_BYTES) {
    throw new Error(`replay decoded byte limit must be between 1 and ${MAX_REPLAY_DECODED_BYTES}`);
  }
  return { eventLimit, maxDecodedBytes };
}

function sourceCoordinates(row: Record<string, unknown>): SourceCoordinates {
  const seq = Number(row.seq);
  const stream = String(row.stream);
  const generation = Number(row.file_generation);
  const offset = Number(row.byte_offset);
  const length = Number(row.byte_length);
  if (!Number.isSafeInteger(seq) || seq < 0
    || (stream !== 'runner' && stream !== 'docker')
    || !Number.isSafeInteger(generation) || generation < 0
    || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(length) || length < 1
    || !Number.isSafeInteger(offset + length)) {
    throw new Error('invalid persisted log range');
  }
  return { seq, stream, generation, range: { offset, length } };
}

export class DurableLogStream {
  readonly #db: DatabaseSync;
  readonly #jobId: string;
  readonly #now: () => string;
  readonly #beforeReplayRead?: (sourceSeq: number) => void;
  readonly #readSync: LogStreamIo['readSync'];
  readonly #writeSync: LogStreamIo['writeSync'];
  readonly #fsyncSync: LogStreamIo['fsyncSync'];
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
    this.#readSync = options.io?.readSync ?? ((fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position));
    this.#writeSync = options.io?.writeSync ?? ((fd, buffer, offset, length) => writeSync(fd, buffer, offset, length));
    this.#fsyncSync = options.io?.fsyncSync ?? fsyncSync;
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
    this.#assertOpen();
    if (bytes.byteLength === 0) throw new Error('log append must contain bytes');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Commit the generation identity before opening the file. If the later
      // append becomes ambiguous, recovery can still index the exact bytes.
      const generation = this.#openGeneration(stream);
      try {
        return this.#appendReserved(stream, generation, bytes);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'log generation sealed before append') throw error;
        if (attempt === 2) throw new Error('log generation kept sealing before append');
      }
    }
    throw new Error('log append retry budget exhausted');
  }

  #appendReserved(stream: StreamName, generation: number, bytes: Uint8Array): AppendResult {
    return this.#transaction(() => {
      const latest = this.#db.prepare('SELECT generation, sealed_at FROM job_log_generations WHERE job_id=? AND stream=? ORDER BY generation DESC LIMIT 1').get(this.#jobId, stream) as { generation: number; sealed_at: string | null } | undefined;
      if (!latest || Number(latest.generation) !== generation || latest.sealed_at !== null) throw new Error('log generation sealed before append');
      const row = this.#db.prepare('SELECT path, size_bytes FROM job_log_generations WHERE job_id=? AND stream=? AND generation=?').get(this.#jobId, stream, generation) as { path: string; size_bytes: number };
      const path = this.#generationPath(stream, generation, row.path, true);
      if (path === null) throw new Error('log directory could not be created');
      const opened = openGenerationForAppend(path);
      const offset = Number(row.size_bytes);
      const partial = bytes[bytes.byteLength - 1] !== 0x0a;
      try {
        const before = fstatSync(opened.fd);
        if (!before.isFile()) throw new Error(`${stream} log is not a regular file`);
        if (before.size !== offset) {
          if (before.size > offset) throw new Error(`${stream} log append is ambiguous after durable file write`);
          throw new Error(`${stream} log is not a regular contiguous file`);
        }
        allBytes(opened.fd, bytes, this.#writeSync);
        this.#fsyncSync(opened.fd);
        const expectedSize = offset + bytes.byteLength;
        revalidateAppendFile(path, opened.fd, expectedSize, fileIdentity(before));
        if (opened.created) this.#fsyncSync(this.#logsFd as number);
        const next = this.#nextSeq();
        const updated = this.#db.prepare('UPDATE job_log_generations SET size_bytes=? WHERE job_id=? AND stream=? AND generation=? AND sealed_at IS NULL AND size_bytes=?').run(expectedSize, this.#jobId, stream, generation, offset);
        if (Number(updated.changes) !== 1) throw new Error('log generation changed before append commit');
        this.#db.prepare(`INSERT INTO job_events (job_id, seq, event_type, payload_json, at, stream, file_generation, byte_offset, byte_length, partial)
          VALUES (?, ?, 'log', ?, ?, ?, ?, ?, ?, ?)`).run(this.#jobId, next, json({ jobId: this.#jobId, stream, partial }), this.#now(), stream, generation, offset, bytes.byteLength, partial ? 1 : 0);
        return { seq: next, stream, generation, offset, length: bytes.byteLength, partial };
      } finally { closeSync(opened.fd); }
    });
  }

  appendMetadataSync(event: MetadataEvent, data: Record<string, unknown>): number {
    this.#assertOpen();
    let seq = -1;
    this.#transaction(() => {
      seq = this.#nextSeq();
      this.#db.prepare('INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, ?, ?, ?)').run(this.#jobId, seq, event, json(data), this.#now());
    });
    return seq;
  }

  sealSync(stream: StreamName): void {
    this.#assertOpen();
    this.#transaction(() => {
      const row = this.#db.prepare('SELECT generation, path, size_bytes, sealed_at FROM job_log_generations WHERE job_id=? AND stream=? ORDER BY generation DESC LIMIT 1').get(this.#jobId, stream) as { generation: number; path: string; size_bytes: number; sealed_at: string | null } | undefined;
      if (!row || row.sealed_at !== null) return;
      const path = this.#generationPath(stream, Number(row.generation), row.path);
      if (path === null) throw new Error(`${stream} log directory is missing`);
      const opened = openRegularFile(path);
      try {
        this.#fsyncSync(opened.fd);
        if (opened.size !== Number(row.size_bytes)) throw new Error(`${stream} log size diverged before seal`);
        const sha256 = hashRegularFile(opened.fd, opened.size, this.#readSync);
        revalidateHashedFile(path, opened.fd, opened.identity, opened.size);
        this.#sealGenerationInTransaction(stream, Number(row.generation), Number(row.size_bytes), sha256);
      } finally { closeSync(opened.fd); }
    });
  }

  rotateSync(stream: StreamName): { readonly generation: number; readonly path: string } {
    this.#assertOpen();
    this.sealSync(stream);
    const generation = this.#openGeneration(stream, true);
    const path = `logs/${stream}.${generation}`;
    return { generation, path };
  }

  sealOrphanTailSync(stream: StreamName, proof: { readonly unitInactive: boolean; readonly leaseStale: boolean; readonly noMatchingContainer: boolean }): OrphanTailResult {
    this.#assertOpen();
    if (!proof.unitInactive || !proof.leaseStale || !proof.noMatchingContainer) throw new Error('orphan log sealing requires liveness proof');
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT generation, path, size_bytes, sealed_at FROM job_log_generations WHERE job_id=? AND stream=? ORDER BY generation DESC LIMIT 1').get(this.#jobId, stream) as { generation: number; path: string; size_bytes: number; sealed_at: string | null } | undefined;
      if (!row) throw new Error('log generation does not exist');
      const path = this.#generationPath(stream, Number(row.generation), row.path);
      if (path === null) throw new Error(`${stream} log directory is missing`);
      const opened = openRegularFile(path);
      const indexed = Number(row.size_bytes);
      try {
        this.#fsyncSync(opened.fd);
        if (opened.size < indexed) {
          return this.#persistOrphanGapInTransaction(stream, Number(row.generation), opened.size, indexed - opened.size);
        }
        if (row.sealed_at !== null) {
          const existing = this.#orphanResult(stream, Number(row.generation));
          return existing ?? this.#sealedResult(stream, Number(row.generation), indexed);
        }
        const tailLength = opened.size - indexed;
        if (tailLength === 0) {
          const sha256 = hashRegularFile(opened.fd, opened.size, this.#readSync);
          revalidateHashedFile(path, opened.fd, opened.identity, opened.size);
          this.#sealGenerationInTransaction(stream, Number(row.generation), indexed, sha256);
          return this.#sealedResult(stream, Number(row.generation), indexed);
        }
        const finalByte = Buffer.alloc(1);
        readExactly(opened.fd, finalByte, opened.size - 1, this.#readSync);
        const partial = finalByte[0] !== 0x0a;
        const sha256 = hashRegularFile(opened.fd, opened.size, this.#readSync);
        revalidateHashedFile(path, opened.fd, opened.identity, opened.size);
        const next = this.#nextSeq();
        const updated = this.#db.prepare('UPDATE job_log_generations SET size_bytes=? WHERE job_id=? AND stream=? AND generation=? AND sealed_at IS NULL AND size_bytes=?').run(opened.size, this.#jobId, stream, row.generation, indexed);
        if (Number(updated.changes) !== 1) throw new Error('log generation changed before orphan seal');
        this.#db.prepare(`INSERT INTO job_events (job_id, seq, event_type, payload_json, at, stream, file_generation, byte_offset, byte_length, partial)
          VALUES (?, ?, 'log_orphan_tail', ?, ?, ?, ?, ?, ?, ?)`).run(this.#jobId, next, json({ jobId: this.#jobId, stream, generation: row.generation, offset: indexed, length: tailLength, partial }), this.#now(), stream, row.generation, indexed, tailLength, partial ? 1 : 0);
        this.#sealGenerationInTransaction(stream, Number(row.generation), opened.size, sha256);
        return { eventType: 'log_orphan_tail', seq: next, stream, generation: Number(row.generation), offset: indexed, length: tailLength };
      } finally { closeSync(opened.fd); }
    });
  }

  replaySync(afterSeq: number, requestedLimits: ReplayLimits = {}): LogStreamEvent[] {
    this.#assertOpen();
    const limits = replayLimits(afterSeq, requestedLimits);
    const discoveredIdentities = new Map<number, FileIdentity>();
    for (const row of this.#sourceRows(Math.max(0, afterSeq), limits.eventLimit)) {
      const source = sourceCoordinates(row);
      if (this.#sourceGap(source.seq)) continue;
      const identity = this.#discoverIdentity(source);
      if (identity !== undefined) discoveredIdentities.set(source.seq, identity);
    }

    const output: LogStreamEvent[] = [];
    let decodedBytes = 0;
    for (const row of this.#eventRows(afterSeq, limits.eventLimit)) {
      const seq = Number(row.seq);
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      if (row.stream === null) {
        if (row.event_type === 'log-gap') output.push({ seq, event: 'log-gap', data: payload });
        else if (row.event_type === 'log-truncated') output.push({ seq, event: 'log-truncated', data: payload });
        else output.push({ seq, event: row.event_type === 'terminal' ? 'terminal' : 'stage', data: payload });
        continue;
      }

      const source = sourceCoordinates(row);
      if (this.#sourceGap(source.seq)) continue;
      const expectedIdentity = discoveredIdentities.get(source.seq) ?? this.#discoverIdentity(source);
      if (expectedIdentity === undefined) continue;
      const generationRow = this.#generationRow(source);
      if (generationRow === undefined || generationRow.path !== `logs/${source.stream}.${source.generation}`) {
        this.#gap(source.seq, source.stream, source.generation, source.range, 'READ_RACE');
        continue;
      }
      const path = this.#generationPath(source.stream, source.generation, generationRow.path);
      if (path === null) {
        this.#gap(source.seq, source.stream, source.generation, source.range, 'READ_RACE');
        continue;
      }
      if (source.range.length > limits.maxDecodedBytes - decodedBytes) {
        if (decodedBytes > 0) break;
        output.push({
          seq,
          event: 'log-truncated',
          data: {
            ...payload,
            jobId: this.#jobId,
            stream: source.stream,
            generation: source.generation,
            offset: source.range.offset,
            length: source.range.length,
            partial: Number(row.partial) === 1,
            truncated: true,
            reason: 'REPLAY_EVENT_TOO_LARGE',
          },
        });
        continue;
      }
      this.#beforeReplayRead?.(seq);
      let bytes: Buffer;
      try {
        bytes = readRegularRange(path, source.range.offset, source.range.length, expectedIdentity, this.#readSync);
      } catch (error) {
        if (isUnsafeAuthorityError(error)) throw error;
        this.#gap(source.seq, source.stream, source.generation, source.range, 'READ_RACE');
        continue;
      }
      decodedBytes += bytes.byteLength;
      output.push({
        seq,
        event: 'log',
        data: {
          ...payload,
          jobId: this.#jobId,
          stream: source.stream,
          generation: source.generation,
          offset: source.range.offset,
          length: source.range.length,
          partial: Number(row.partial) === 1,
          bytesBase64: bytes.toString('base64'),
          ...validUtf8Text(bytes),
        },
      });
    }
    return output;
  }

  encodeSse(event: LogStreamEvent): string {
    this.#assertOpen();
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

  keepalive(): string {
    this.#assertOpen();
    return ': keepalive\n\n';
  }

  keepaliveIterator(signal?: AbortSignal): AsyncGenerator<string> {
    this.#assertOpen();
    return this.#iterateKeepalives(signal);
  }

  async *#iterateKeepalives(signal?: AbortSignal): AsyncGenerator<string> {
    while (!signal?.aborted) {
      this.#assertOpen();
      await keepaliveDelay(signal);
      this.#assertOpen();
      if (!signal?.aborted) yield this.keepalive();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('durable log stream is closed');
  }

  #openGeneration(stream: StreamName, forceNew = false): number {
    return this.#transaction(() => this.#openGenerationInTransaction(stream, forceNew));
  }

  #openGenerationInTransaction(stream: StreamName, forceNew = false): number {
    const row = this.#db.prepare('SELECT generation, sealed_at FROM job_log_generations WHERE job_id=? AND stream=? ORDER BY generation DESC LIMIT 1').get(this.#jobId, stream) as { generation: number; sealed_at: string | null } | undefined;
    if (row && row.sealed_at === null && !forceNew) return Number(row.generation);
    const generation = row ? Number(row.generation) + 1 : 0;
    this.#db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at) VALUES (?, ?, ?, ?, ?)').run(this.#jobId, stream, generation, `logs/${stream}.${generation}`, this.#now());
    return generation;
  }

  #generationPath(stream: StreamName, generation: number, persistedPath: string, createLogs = false): string | null {
    const expected = `logs/${stream}.${generation}`;
    if (persistedPath !== expected) throw new Error('log generation path does not match fixed generation identity');
    const logsFd = createLogs ? this.#ensureLogsDirectory() : this.#refreshLogsDirectory();
    return logsFd === null ? null : descriptorChild(logsFd, `${stream}.${generation}`);
  }

  #refreshLogsDirectory(): number | null {
    if (this.#logsFd !== null) return this.#logsFd;
    this.#logsFd = openOptionalDirectoryChild(this.#rootFd, 'logs');
    return this.#logsFd;
  }

  #ensureLogsDirectory(): number {
    if (this.#logsFd !== null) return this.#logsFd;
    let created = false;
    try {
      mkdirSync(descriptorChild(this.#rootFd, 'logs'), { mode: 0o750 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (created) this.#fsyncSync(this.#rootFd);
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

  #eventRows(afterSeq: number, limit: number): Array<Record<string, unknown>> {
    return this.#db.prepare(`SELECT event.seq, event.event_type, event.payload_json, event.at, event.stream, event.file_generation, event.byte_offset, event.byte_length, event.partial
      FROM job_events AS event
      WHERE event.job_id=? AND event.seq>?
        AND NOT (event.stream IS NOT NULL AND EXISTS (
          SELECT 1 FROM job_events AS gap
          WHERE gap.job_id=event.job_id
            AND gap.event_type='log-gap'
            AND json_extract(gap.payload_json, '$.sourceSeq')=event.seq
        ))
      ORDER BY event.seq
      LIMIT ?`).all(this.#jobId, afterSeq, limit) as Array<Record<string, unknown>>;
  }

  #sourceRows(fromSeq: number, limit: number): Array<Record<string, unknown>> {
    return this.#db.prepare(`SELECT seq, event_type, payload_json, at, stream, file_generation, byte_offset, byte_length, partial
      FROM job_events
      WHERE job_id=? AND stream IS NOT NULL AND seq>=?
      ORDER BY seq
      LIMIT ?`).all(this.#jobId, fromSeq, limit) as Array<Record<string, unknown>>;
  }

  #generationRow(source: SourceCoordinates): { readonly path: string; readonly size_bytes: number } | undefined {
    return this.#db.prepare('SELECT path, size_bytes FROM job_log_generations WHERE job_id=? AND stream=? AND generation=?')
      .get(this.#jobId, source.stream, source.generation) as { path: string; size_bytes: number } | undefined;
  }

  #discoverIdentity(source: SourceCoordinates): FileIdentity | undefined {
    const generationRow = this.#generationRow(source);
    if (generationRow === undefined) {
      this.#gap(source.seq, source.stream, source.generation, source.range, 'GENERATION_MISSING');
      return undefined;
    }
    if (generationRow.path !== `logs/${source.stream}.${source.generation}`) {
      this.#gap(source.seq, source.stream, source.generation, source.range, 'GENERATION_PATH_MISMATCH');
      return undefined;
    }
    const path = this.#generationPath(source.stream, source.generation, generationRow.path);
    const identity = this.#rangeIdentity(path, source.range.offset, source.range.length);
    if (identity === null) {
      this.#gap(source.seq, source.stream, source.generation, source.range, 'RANGE_UNREADABLE');
      return undefined;
    }
    return identity;
  }

  #sourceGap(sourceSeq: number): { readonly seq: number; readonly payload_json: string } | undefined {
    return this.#db.prepare("SELECT seq, payload_json FROM job_events WHERE job_id=? AND event_type='log-gap' AND json_extract(payload_json, '$.sourceSeq')=?").get(this.#jobId, sourceSeq) as { seq: number; payload_json: string } | undefined;
  }

  #sealGenerationInTransaction(stream: StreamName, generation: number, size: number, sha256: string): void {
    const updated = this.#db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=? AND stream=? AND generation=? AND sealed_at IS NULL AND size_bytes=?').run(this.#now(), sha256, this.#jobId, stream, generation, size);
    if (Number(updated.changes) !== 1) throw new Error('log generation changed before seal');
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve primary error */ }
      throw error;
    }
  }

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

  #persistOrphanGapInTransaction(stream: StreamName, generation: number, offset: number, length: number): OrphanTailResult {
    const key = `orphan:${stream}:${generation}`;
    const existing = this.#db.prepare("SELECT seq, payload_json FROM job_events WHERE job_id=? AND event_type='log-gap' AND json_extract(payload_json, '$.orphanKey')=?").get(this.#jobId, key) as { seq: number; payload_json: string } | undefined;
    if (existing) { const data = JSON.parse(existing.payload_json) as Record<string, unknown>; return { eventType: 'log-gap', seq: Number(existing.seq), stream, generation, offset: Number(data.offset), length: Number(data.length) }; }
    const data = { jobId: this.#jobId, code: 'RECOVERY_LOG_GAP', stream, generation, offset, length, path: `logs/${stream}.${generation}`, orphanKey: key };
    const seq = this.#nextSeq();
    this.#db.prepare("INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, 'log-gap', ?, ?)").run(this.#jobId, seq, json(data), this.#now());
    return { eventType: 'log-gap', seq, stream, generation, offset, length };
  }

  #orphanResult(stream: StreamName, generation: number): OrphanTailResult | undefined {
    const row = this.#db.prepare("SELECT seq, stream, file_generation, byte_offset, byte_length, event_type, payload_json FROM job_events WHERE job_id=? AND event_type='log_orphan_tail' AND stream=? AND file_generation=? ORDER BY seq DESC LIMIT 1").get(this.#jobId, stream, generation) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { eventType: row.event_type as 'log_orphan_tail' | 'log-gap', seq: Number(row.seq), stream, generation, offset: Number(row.byte_offset ?? JSON.parse(String(row.payload_json)).offset), length: Number(row.byte_length ?? JSON.parse(String(row.payload_json)).length) };
  }

  #sealedResult(stream: StreamName, generation: number, size: number): OrphanTailResult {
    return { eventType: 'sealed', seq: -1, stream, generation, offset: size, length: 0 };
  }
}

function openGenerationForAppend(path: string): { readonly fd: number; readonly created: boolean } {
  const existingFlags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | O_CLOEXEC;
  try {
    const fd = openSync(path, existingFlags | constants.O_CREAT | constants.O_EXCL, 0o640);
    return { fd, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { fd: openSync(path, existingFlags), created: false };
  }
}

function readExactly(fd: number, buffer: Buffer, position: number, read: LogStreamIo['readSync']): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const count = read(fd, buffer, offset, buffer.byteLength - offset, position + offset);
    if (count <= 0) throw new Error('log read made zero progress');
    if (count > buffer.byteLength - offset) throw new Error('log read reported invalid progress');
    offset += count;
  }
}

function openRegularFile(path: string): { readonly fd: number; readonly size: number; readonly identity: FileIdentity } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('log generation is not a regular file');
    return { fd, size: stat.size, identity: fileIdentity(stat) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function revalidateAppendFile(path: string, fd: number, expectedSize: number, before: FileIdentity): void {
  const current = fileIdentity(fstatSync(fd));
  if (current.size !== expectedSize || !sameFileLocation(current, before)) throw new Error('log generation changed before append commit');
  if (!sameFileIdentity(fileIdentityAtPath(path), current)) throw new Error('log generation pathname changed before append commit');
}

function revalidateHashedFile(path: string, fd: number, expected: FileIdentity, expectedSize: number): void {
  const current = fileIdentity(fstatSync(fd));
  if (current.size !== expectedSize || !sameFileIdentity(current, expected)) throw new Error('log generation changed during seal');
  if (!sameFileIdentity(fileIdentityAtPath(path), current)) throw new Error('log generation pathname changed during seal');
}

function fileIdentityAtPath(path: string): FileIdentity {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('log generation is not a regular file');
    return fileIdentity(stat);
  } finally { closeSync(fd); }
}

function hashRegularFile(fd: number, size: number, read: LogStreamIo['readSync']): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_SIZE, size));
  for (let position = 0; position < size; position += buffer.byteLength) {
    const length = Math.min(buffer.byteLength, size - position);
    readExactly(fd, buffer.subarray(0, length), position, read);
    hash.update(buffer.subarray(0, length));
  }
  return hash.digest('hex');
}

function readRegularRange(path: string, offset: number, length: number, expected: FileIdentity, read: LogStreamIo['readSync']): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('log generation is not a regular file');
    if (!sameFileIdentity(fileIdentity(stat), expected)) throw new Error('log generation changed during replay');
    if (stat.size < offset + length) throw new Error('short log range');
    const data = Buffer.alloc(length);
    readExactly(fd, data, offset, read);
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

function sameFileLocation(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
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

function keepaliveDelay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveDelay();
    };
    const onAbort = (): void => finish();
    timer = setTimeout(finish, 15_000);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) finish();
  });
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
