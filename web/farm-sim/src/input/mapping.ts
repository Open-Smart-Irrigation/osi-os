import type {TileRef, ToolId, ViewModel} from '../core/types';

export type Direction = {dx: number; dy: number};

const DIRECTION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);

export function isDirectionKey(code: string): boolean {
  return DIRECTION_KEYS.has(code);
}

export function keyboardDirection(held: ReadonlySet<string>): Direction {
  const dx = Number(held.has('ArrowRight') || held.has('KeyD')) - Number(held.has('ArrowLeft') || held.has('KeyA'));
  const dy = Number(held.has('ArrowDown') || held.has('KeyS')) - Number(held.has('ArrowUp') || held.has('KeyW'));
  return {dx: Math.sign(dx), dy: Math.sign(dy)};
}

export function stickDirection(x: number, y: number): Direction {
  if (Math.hypot(x, y) < 10) return {dx: 0, dy: 0};
  const angle = Math.round(Math.atan2(y, x) * 4 / Math.PI) * Math.PI / 4;
  return {dx: Math.round(Math.cos(angle)) || 0, dy: Math.round(Math.sin(angle)) || 0};
}

export function toolForKey(code: string, tools: readonly ToolId[]): ToolId | undefined {
  return /^Digit[1-5]$/.test(code) ? tools[Number(code.slice(-1)) - 1] : undefined;
}

export function facingTile(player: ViewModel['player']): TileRef {
  const {x, y} = player.at;
  switch (player.facing) {
    case 'north': return {x, y: y - 1};
    case 'south': return {x, y: y + 1};
    case 'west': return {x: x - 1, y};
    case 'east': return {x: x + 1, y};
  }
}

export function tileAt(map: ViewModel['map'], at: TileRef) {
  return at.x >= 0 && at.y >= 0 && at.x < map.width && at.y < map.height
    ? map.tiles[at.y * map.width + at.x] : undefined;
}

export function isClose(from: TileRef, to: TileRef): boolean {
  return Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) <= 1;
}

const DIRECTIONS: readonly Direction[] = [
  {dx: 0, dy: -1}, {dx: -1, dy: 0}, {dx: 1, dy: 0}, {dx: 0, dy: 1},
  {dx: -1, dy: -1}, {dx: 1, dy: -1}, {dx: -1, dy: 1}, {dx: 1, dy: 1},
];

/** Find the first step of a shortest route, with the same diagonal wall rule as the world. */
export function routeStep(map: ViewModel['map'], from: TileRef, to: TileRef, adjacent: boolean): Direction | null {
  const queue: {at: TileRef; first: Direction | null}[] = [{at: from, first: null}];
  const seen = new Set([from.y * map.width + from.x]);
  for (let index = 0; index < queue.length; index++) {
    const {at, first} = queue[index];
    if (adjacent ? isClose(at, to) : at.x === to.x && at.y === to.y) return first;
    for (const direction of DIRECTIONS) {
      const {dx, dy} = direction;
      const next = {x: at.x + dx, y: at.y + dy};
      const key = next.y * map.width + next.x;
      if (seen.has(key) || !tileAt(map, next)?.walkable) continue;
      if (dx && dy && (!tileAt(map, {x: next.x, y: at.y})?.walkable
        || !tileAt(map, {x: at.x, y: next.y})?.walkable)) continue;
      seen.add(key);
      queue.push({at: next, first: first ?? direction});
    }
  }
  return null;
}
