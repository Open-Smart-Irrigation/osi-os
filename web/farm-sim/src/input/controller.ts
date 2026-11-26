import {FARM_SITES} from '../core/map';
import type {Command} from '../core/commands';
import type {TileRef, ToolId, ViewModel} from '../core/types';
import {facingTile, isClose, isDirectionKey, keyboardDirection, routeStep, tileAt, toolForKey, type Direction} from './mapping';
import {pointerTile} from './pointer';

type Target = {tile: TileRef; action: 'walk' | 'sleep' | 'interact' | ToolId};

interface Controls {
  view(): ViewModel;
  send(command: Command): void;
  isBlocked(): boolean;
  openPhone(): void;
  sleep(): void;
  toggleFacilitator(): void;
}

const STEP_INTERVAL_MS = 105;

export function inputController(canvas: HTMLCanvasElement, controls: Controls) {
  const held = new Set<string>();
  let stick = {dx: 0, dy: 0};
  let lastMove = -Infinity;
  let destination: Target | undefined;
  let selected: ToolId = 'can';

  function clear() {
    held.clear();
    stick = {dx: 0, dy: 0};
    destination = undefined;
  }

  function target(tile: TileRef, action: Target['action']) {
    destination = {tile, action};
  }

  function click(event: PointerEvent) {
    if (controls.isBlocked() || event.button !== 0 || !event.isPrimary) return;
    const vm = controls.view();
    const tile = pointerTile(vm, canvas.getBoundingClientRect(), event.clientX, event.clientY);
    if (!tile) return;
    const cell = tileAt(vm.map, tile);
    if (cell?.feature === 'door' || cell?.feature === 'bed' || cell?.feature === 'house') {
      target(FARM_SITES.houseDoor, vm.hud.canSleep ? 'sleep' : 'interact');
    } else if (cell?.feature === 'tank' || cell?.feature === 'shared-well') {
      const container = selected === 'can' || selected === 'jerrycan';
      target(tile, container && !event.shiftKey ? selected : 'interact');
    } else if (cell?.bed) {
      target(tile, event.shiftKey ? 'interact' : selected);
    } else if (cell?.feature === 'pump' || cell?.feature === 'well' || cell?.feature === 'nursery') {
      target(tile, 'interact');
    } else if (cell?.walkable) target(tile, 'walk');
  }

  function useSelected() {
    if (controls.isBlocked()) return;
    const vm = controls.view();
    controls.send({kind: 'useTool', tool: selected, tile: facingTile(vm.player)});
  }

  function keydown(event: KeyboardEvent) {
    if (event.target instanceof HTMLElement && event.target.closest('input,select,textarea,[contenteditable=true]')) return;
    if (event.code === 'KeyF' && event.shiftKey && !event.repeat) {
      controls.toggleFacilitator();
      event.preventDefault();
      return;
    }
    if (event.code === 'KeyP' && !event.repeat) {
      controls.openPhone();
      event.preventDefault();
      return;
    }
    if (controls.isBlocked() || event.altKey || event.ctrlKey || event.metaKey) return;
    if (isDirectionKey(event.code)) {
      held.add(event.code);
      destination = undefined;
      event.preventDefault();
      return;
    }
    if (event.repeat) return;
    const vm = controls.view();
    const tool = toolForKey(event.code, vm.hud.tools);
    if (tool) selected = tool;
    else if (event.code === 'KeyB') target(FARM_SITES.houseDoor, 'sleep');
    else if (event.code === 'KeyE') controls.send({kind: 'interact', tile: facingTile(vm.player)});
    else if (event.code === 'Space' && !(event.target instanceof HTMLButtonElement)) {
      useSelected();
    } else return;
    event.preventDefault();
  }

  function keyup(event: KeyboardEvent) { held.delete(event.code); }

  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);
  window.addEventListener('blur', clear);
  canvas.addEventListener('pointerup', click);

  return {
    clear, target, useSelected,
    get selected() { return selected; },
    select(tool: ToolId) { selected = tool; },
    setStick(direction: Direction) {
      stick = direction;
      if (stick.dx || stick.dy) destination = undefined;
    },
    update(now: number) {
      if (controls.isBlocked() || now - lastMove < STEP_INTERVAL_MS) return;
      const vm = controls.view();
      if (['pump', 'pour', 'carry'].includes(vm.player.activity)) return;
      const keyboard = keyboardDirection(held);
      const manual = keyboard.dx || keyboard.dy ? keyboard : stick;
      const move = (direction: Direction) => {
        controls.send({kind: 'move', ...direction});
        lastMove = now;
      };
      if (manual.dx || manual.dy) {
        move(manual);
        return;
      }
      if (!destination) return;
      const {tile, action} = destination;
      const direction = routeStep(vm.map, vm.player.at, tile, action !== 'walk');
      if (direction) {
        move(direction);
        return;
      }
      destination = undefined;
      if (!isClose(vm.player.at, tile)) return;
      if (action === 'sleep') controls.sleep();
      else if (action === 'interact') controls.send({kind: 'interact', tile});
      else if (action !== 'walk') controls.send({kind: 'useTool', tool: action, tile});
    },
  };
}
