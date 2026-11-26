import type {Simulator} from '@osi-demo/model';
import type {Command} from '../commands';
import type {Tier} from '../types';
import {checkRead, checkWrite, normalizePath, type Refusal} from './allow-list';
import type {DemoResponse} from './types';

export type PhoneWrite = Omit<Extract<Command, {kind: 'phoneRequest'}>, 'simNow' | 'seq'>;

/** Run owns both calls and uses the same queue and dispatcher for player and phone commands. */
export interface PhoneDispatcher {
  dispatchQueued(): void;
  dispatchPhone(command: PhoneWrite): DemoResponse;
}

export type PhoneTraffic =
  | {type: 'phone_refused'; method: string; path: string; code: Refusal | 'phone_asleep'; simNow: number}
  | {type: 'api_read'; path: string};

const SETTINGS = '/api/system/settings';
const LAST_ANSWERS_LIMIT = 64;
const MESSAGES = {
  game_refused: 'Not part of this game. Nothing was changed.',
  game_tier: 'Your farm needs a higher OSI level for this. Nothing was changed.',
} as const;

export class PhoneBridge {
  private open = false;
  private readonly traffic = {simulatorCalls: 0, closedCacheHits: 0, closedCacheMisses: 0};
  private frozenAt: number;
  private memoAt: number | undefined;
  private readonly memo = new Map<string, DemoResponse>();
  private readonly last = new Map<string, DemoResponse>();

  constructor(private readonly sim: Simulator, private readonly tier: Tier,
    private readonly dispatcher: PhoneDispatcher, private readonly log?: (event: PhoneTraffic) => void) {
    this.frozenAt = sim.now;
  }

  setOpen(open: boolean): void {
    if (this.open && !open) this.frozenAt = this.sim.now;
    this.open = open && this.tier > 0;
    this.invalidate();
  }

  isOpen(): boolean {
    return this.open;
  }

  now(): number {
    return this.open ? this.sim.now : this.frozenAt;
  }

  stats() { return {...this.traffic}; }

  invalidate(): void {
    this.memo.clear();
    this.memoAt = this.sim.now;
  }

  request(method: string, path: string, body: unknown): DemoResponse {
    const verb = method.toUpperCase();
    if (verb !== 'GET') this.dispatcher.dispatchQueued();
    const url = normalizePath(path);
    const route = url?.pathname ?? '';
    const key = route + (url?.search ?? '');
    if (!this.open) {
      if (verb === 'GET' && url) {
        const cached = this.last.get(key);
        if (cached) {
          this.traffic.closedCacheHits++;
          return structuredClone(cached);
        }
        this.traffic.closedCacheMisses++;
      }
      return this.refuse(verb, route, 'phone_asleep');
    }
    if (!url) return this.refuse(verb, route, 'game_refused');
    if (verb === 'GET') {
      const refusal = checkRead(this.tier, url, this.sim.now);
      if (refusal) return this.refuse(verb, route, refusal);
      this.log?.({type: 'api_read', path: route});
      if (this.memoAt !== this.sim.now) this.invalidate();
      let result = this.memo.get(key);
      if (!result) {
        this.traffic.simulatorCalls++;
        result = this.sim.requestResponse(verb, key);
        this.memo.set(key, result);
        this.last.delete(key);
        this.last.set(key, result);
        if (this.last.size > LAST_ANSWERS_LIMIT) {
          const first = [...this.last.keys()].find(candidate => candidate !== SETTINGS);
          if (first !== undefined) this.last.delete(first);
        }
      }
      return structuredClone(result);
    }
    const result = checkWrite(this.tier, verb, route, body);
    if ('code' in result) return this.refuse(verb, route, result.code);
    // Allowed writes have no query parameters. Only validated fields enter the command queue.
    this.traffic.simulatorCalls++;
    return this.dispatcher.dispatchPhone({kind: 'phoneRequest', method: verb, path: route, body: result.body});
  }

  private refuse(method: string, path: string, code: Refusal | 'phone_asleep'): DemoResponse {
    if (method !== 'GET' || code !== 'phone_asleep') {
      this.log?.({type: 'phone_refused', method, path, code, simNow: this.sim.now});
    }
    const message = code === 'game_refused' || code === 'game_tier' ? MESSAGES[code] : undefined;
    return {
      status: code === 'phone_asleep' ? 503 : code === 'invalid' ? 422 : 403,
      headers: {'content-type': 'application/json'},
      data: message ? {error: code, message} : {error: code},
    };
  }
}
