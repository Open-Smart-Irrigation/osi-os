import type {TileRef, ToolId} from './types';

export type Command =
  | {kind: 'move'; dx: number; dy: number}
  | {kind: 'interact'; tile: TileRef}
  | {kind: 'useTool'; tool: ToolId; tile: TileRef}
  | {kind: 'sleep'}
  | {kind: 'phoneOpen'}
  | {kind: 'phoneClose'}
  // The dispatcher sets simNow and seq.
  | {kind: 'phoneRequest'; method: string; path: string; body: unknown; simNow: number; seq: number};
