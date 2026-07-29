import {
  canonicalInstant,
  SharedValidationError,
  sourceMetadataSubject,
} from './validation.js';
import {
  validateRemoteBranchName,
  type BranchList,
  type RemoteBranch,
} from './git/source-resolver.js';

export const DEFAULT_BRANCH_CACHE_TTL_MS = 300_000;
const MAX_BRANCHES = 1_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export interface BranchCacheSource {
  listBranches(): Promise<BranchList>;
}

export interface BranchCacheOptions {
  readonly ttlMs?: number;
  readonly clock?: () => number;
}

export interface BranchCachePeek {
  readonly snapshot: Readonly<BranchList> | null;
  readonly stale: boolean;
}

function invalid(field: string): never {
  throw new SharedValidationError(`${field} is invalid`);
}

function copyBranchList(value: unknown): Readonly<BranchList> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('branch list');
  const input = value as { readonly fetchedAt?: unknown; readonly branches?: unknown };
  const fetchedAt = canonicalInstant(input.fetchedAt, 'branch list fetchedAt');
  if (!Array.isArray(input.branches) || input.branches.length > MAX_BRANCHES) invalid('branch list branches');

  const branches: RemoteBranch[] = input.branches.map((value, index) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`branch list branches[${index}]`);
    const inputBranch = value as {
      readonly name?: unknown;
      readonly sha?: unknown;
      readonly commitTime?: unknown;
      readonly subject?: unknown;
    };
    const name = validateRemoteBranchName(inputBranch.name);
    if (typeof inputBranch.sha !== 'string' || !SHA_PATTERN.test(inputBranch.sha)) invalid(`branch list branches[${index}].sha`);
    const commitTime = canonicalInstant(inputBranch.commitTime, `branch list branches[${index}].commitTime`);
    const subject = sourceMetadataSubject(inputBranch.subject, `branch list branches[${index}].subject`);
    return Object.freeze({ name, sha: inputBranch.sha, commitTime, subject });
  });

  branches.sort((first, second) => first.name < second.name ? -1 : first.name > second.name ? 1 : 0);
  for (let index = 1; index < branches.length; index += 1) {
    if (branches[index - 1]!.name === branches[index]!.name) invalid(`branch list branches[${index}].name`);
  }
  return Object.freeze({ fetchedAt, branches: Object.freeze(branches) });
}

function validateClockValue(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('Branch cache clock must return a non-negative finite number.');
  return value;
}

export class BranchCache {
  readonly #source: BranchCacheSource;
  readonly #ttlMs: number;
  readonly #clock: () => number;
  #snapshot: Readonly<BranchList> | null = null;
  #completedAt: number | null = null;
  #lastClock: number | null = null;
  #inFlight: Promise<Readonly<BranchList>> | null = null;

  constructor(source: BranchCacheSource, options: BranchCacheOptions = {}) {
    if (source === null || typeof source !== 'object' || typeof source.listBranches !== 'function') {
      throw new TypeError('Branch cache source must provide listBranches().');
    }
    const ttlMs = options.ttlMs ?? DEFAULT_BRANCH_CACHE_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError('Branch cache TTL must be a non-negative finite number.');
    if (options.clock !== undefined && typeof options.clock !== 'function') throw new TypeError('Branch cache clock must be a function.');
    this.#source = source;
    this.#ttlMs = ttlMs;
    this.#clock = options.clock ?? (() => performance.now());
  }

  get(): Promise<Readonly<BranchList>> {
    const now = this.#observeClock();
    if (this.#inFlight !== null) return this.#inFlight;
    if (this.#snapshot !== null && this.#completedAt !== null && now - this.#completedAt <= this.#ttlMs) {
      return Promise.resolve(this.#snapshot);
    }
    return this.#fetch();
  }

  refresh(): Promise<Readonly<BranchList>> {
    this.#observeClock();
    return this.#inFlight ?? this.#fetch();
  }

  peek(): BranchCachePeek {
    const now = this.#observeClock();
    const stale = this.#snapshot !== null && this.#completedAt !== null
      ? now - this.#completedAt > this.#ttlMs
      : false;
    return Object.freeze({ snapshot: this.#snapshot, stale });
  }

  #observeClock(): number {
    const current = validateClockValue(this.#clock());
    if (this.#lastClock !== null && current < this.#lastClock) throw new Error('Branch cache clock regression detected.');
    this.#lastClock = current;
    return current;
  }

  #fetch(): Promise<Readonly<BranchList>> {
    const flight = (async () => {
      const result = copyBranchList(await this.#source.listBranches());
      const completedAt = this.#observeClock();
      this.#snapshot = result;
      this.#completedAt = completedAt;
      return result;
    })();
    this.#inFlight = flight;
    void flight.then(
      () => { if (this.#inFlight === flight) this.#inFlight = null; },
      () => { if (this.#inFlight === flight) this.#inFlight = null; },
    );
    return flight;
  }
}

export default BranchCache;
