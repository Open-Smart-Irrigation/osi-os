import {silhouette} from '../core';
import {playerSprites} from './player';
import {deviceSprites, structureSprites, waterSprites} from './world';

// Every frame the view lets cast a long, sun-sheared shadow: the casters in
// src/view/actors.ts and the farmer. Each gets a cream mask of its own shape, which the view
// tints, so the shadow takes the colour of the hour instead of the caster's paint.
const CASTS = /^(structure\.farmhouse(\.lit)?|nature\.acacia|water\.(tank|well)\..+|device\.gateway\..+|player\..+)$/;

export const shadowSprites = [...structureSprites, ...waterSprites, ...deviceSprites, ...playerSprites]
  .filter(({id}) => CASTS.test(id))
  .map(frame => silhouette(frame));
