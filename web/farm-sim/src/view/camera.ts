import type {ViewModel} from './view-model';

export const TILE_SIZE = 16;

/** A logical view size in pixels. */
export type ViewSize = Readonly<{width: number; height: number}>;
/** The landscape and desktop view (plan D8). Portrait gets a taller, narrower one (portraitViewport). */
export const LANDSCAPE_VIEW: ViewSize = Object.freeze({width: 480, height: 270});

// The pointer mapping defaults to the renderer's last logical view and device scale.
let fittedViewport = {view: LANDSCAPE_VIEW, scale: 1};
export const currentViewport = () => fittedViewport;
export function setCurrentViewport(view: ViewSize, scale: number) {
  fittedViewport = {view, scale};
}

export const cameraShift = (remainder: number, scale: number) => Math.floor(remainder * scale);

export function tileFoot(at: ViewModel['player']['at']) {
  return {x: (at.x + .5) * TILE_SIZE, y: (at.y + .5) * TILE_SIZE};
}

function followAxis(focus: number, length: number, viewport: number) {
  const clamped = Math.max(0, Math.min(length * TILE_SIZE - viewport, focus - viewport / 2));
  const pixel = Math.floor(clamped);
  return {pixel, remainder: clamped - pixel};
}

// The landscape view is the default for callers that render only that view.
export function followCamera(map: ViewModel['map'], player: ViewModel['player']['at'], view: ViewSize = LANDSCAPE_VIEW) {
  const foot = tileFoot(player);
  const x = followAxis(foot.x, map.width, view.width);
  const y = followAxis(foot.y, map.height, view.height);
  return {x: x.pixel, y: y.pixel, subX: x.remainder, subY: y.remainder};
}

// Landscape and desktop: the 480 x 270 view takes the largest whole-number scale that fits the
// mount, at least 1, centred.
export function fitViewport(deviceWidth: number, deviceHeight: number) {
  const fit = Math.min(deviceWidth / LANDSCAPE_VIEW.width, deviceHeight / LANDSCAPE_VIEW.height);
  const scale = Math.max(1, Math.floor(fit));
  const width = LANDSCAPE_VIEW.width * scale;
  const height = LANDSCAPE_VIEW.height * scale;
  return {scale, width, height, left: Math.floor((deviceWidth - width) / 2), top: Math.floor((deviceHeight - height) / 2)};
}

// Least number of whole tiles across a portrait view [tune].
const PORTRAIT_TILES = 15;

// Portrait (the layout in farm-ui.css): the largest whole-number scale at which PORTRAIT_TILES
// tiles fit across the mount; at that scale the view is as wide and as tall as the mount, no
// taller than the map and at least a tile each way, centred across the top of the mount.
export function portraitViewport(deviceWidth: number, deviceHeight: number, mapHeight = Infinity) {
  const scale = Math.max(1, Math.floor(deviceWidth / (PORTRAIT_TILES * TILE_SIZE)));
  const view: ViewSize = {
    width: Math.max(TILE_SIZE, Math.floor(deviceWidth / scale)),
    height: Math.max(TILE_SIZE, Math.min(mapHeight, Math.floor(deviceHeight / scale))),
  };
  const width = view.width * scale;
  return {scale, width, height: view.height * scale, left: Math.max(0, Math.floor((deviceWidth - width) / 2)), top: 0, view};
}
