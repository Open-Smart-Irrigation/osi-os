import type {Command} from './commands';
import type {IrrigationEvent, ReplayHeader, WorldDayView} from './types';
import type {SliceReport} from './report';

interface Payloads {
  session_start: ReplayHeader;
  command: {tick: number; seq: number; cmd: Exclude<Command, {kind: 'phoneRequest'}>};
  phone_request: {tick: number; method: string; path: string; body: unknown; simNow: number; seq: number};
  phone_refused: {method: string; path: string; code: string; simNow: number};
  api_read: {path: string};
  irrigation: Exclude<IrrigationEvent, {kind: 'cutoff'}>;
  cutoff: Extract<IrrigationEvent, {kind: 'cutoff'}>;
  trigger_evaluation: object;
  world_daily: WorldDayView;
  harvest: {tile: {x: number; y: number}; kg: number};
  report: SliceReport;
  slow_frame: {dropped_ms: number};
}

export type LogEvent = {
  [Type in keyof Payloads]: {seq: number; sim_time: number; type: Type; payload: Payloads[Type]}
}[keyof Payloads];

export class GameLog {
  private readonly events: LogEvent[] = [];

  append<Type extends keyof Payloads>(simTime: number, type: Type, payload: Payloads[Type]): void {
    const event = {seq: this.events.length + 1, sim_time: simTime, type, payload} as LogEvent;
    this.events.push(structuredClone(event));
  }

  since(sequence: number): LogEvent[] {
    return structuredClone(this.events.slice(sequence));
  }
}
