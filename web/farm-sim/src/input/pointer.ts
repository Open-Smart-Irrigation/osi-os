import type {TileRef, ViewModel} from '../core/types';
import {cameraShift, currentViewport, followCamera, TILE_SIZE} from '../view/camera';
import {tileAt} from './mapping';

export function pointerTile(vm: ViewModel, bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  clientX: number, clientY: number, {view, scale} = currentViewport()): TileRef | null {
  const camera = followCamera(vm.map, vm.player.at, view);
  const x = (clientX - bounds.left) / bounds.width * view.width;
  const y = (clientY - bounds.top) / bounds.height * view.height;
  if (!(x >= 0 && x < view.width && y >= 0 && y < view.height)) return null;
  return tileAt(vm.map, {
    x: Math.floor((camera.x + cameraShift(camera.subX, scale) / scale + x) / TILE_SIZE),
    y: Math.floor((camera.y + cameraShift(camera.subY, scale) / scale + y) / TILE_SIZE),
  })?.at ?? null;
}
