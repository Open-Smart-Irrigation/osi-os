import type {Command} from './commands';
import type {TileRef} from './types';
import type {World} from './world';

type Action = Extract<Command, {kind: 'interact' | 'useTool'}>;
export type ActionResult = {
  text: string;
  decision?: 'feel' | 'can' | 'pick' | 'pump' | 'tap' | 'plant' | 'carry';
  pickedKg?: number;
  tapOpen?: boolean;
};

export function withinReach(from: TileRef, target: TileRef): boolean {
  return Math.max(Math.abs(from.x - target.x), Math.abs(from.y - target.y)) <= 1;
}

export function playerAction(world: World, at: number, tier: number, command: Action): ActionResult {
  const {tile: target} = command;
  const tile = world.tileAt(target);
  if (!tile || !withinReach(world.playerTile, target)) return {text: 'Move closer first.'};
  if (world.isBusy(at)) return {text: 'Finish the current chore first.'};
  const site = tile.feature;
  if (command.kind === 'interact') {
    if (site === 'pump' || site === 'well') {
      return world.pump(at) !== null ? {text: 'Pumping water into the tank.', decision: 'pump'}
        : {text: 'Check the tank, well and your energy before pumping.'};
    }
    if (site === 'tank') {
      if (tier >= 3) return {text: 'Use the phone to run the drip valve.'};
      const tapOpen = !world.manualTapOpen;
      world.setManualTap(at, tapOpen);
      return {tapOpen, text: tapOpen ? 'Tap opened. Watch the drip line.' : 'Tap closed.', decision: 'tap'};
    }
    if (site === 'shared-well') return {text: 'Use the can or jerrycan to collect water.'};
    if (site === 'nursery') return {text: 'Till bed B with the hoe, then use a seedling on the tilled soil.'};
    if (site === 'door' || site === 'bed') return {text: 'Use Sleep at the house after 18:00.'};
    const feel = world.feelSoil(at, target);
    return feel ? {text: 'The soil feels ' + feel + '.', decision: 'feel'} : {text: 'Choose a bed or a farm object.'};
  }

  switch (command.tool) {
    case 'can':
    case 'jerrycan': {
      const tool = command.tool;
      if (site === 'shared-well' || site === 'tank') {
        if (site === 'tank' && tool === 'jerrycan') {
          const poured = world.pourTank(at, tool);
          if (poured) return {text: poured + ' L poured into the tank.', decision: 'carry'};
        }
        const filled = site === 'shared-well' ? world.collectFromSharedWell(at, tool) : world.fill(at, tool);
        return {text: filled > 0 ? filled + ' L collected.' : 'Check the water supply, container and your energy.'};
      }
      if (tool === 'jerrycan') return {text: 'Use the jerrycan at a well or the tank.'};
      return world.waterTile(at, target) !== null ? {text: 'Watering this tile.', decision: 'can'}
        : {text: 'Fill your can at the tank, then water a bed tile.'};
    }
    case 'hoe':
      return {text: world.till(at, target) ? 'Soil tilled.' : 'Choose an untilled bed tile and check your energy.'};
    case 'seedling':
      return world.transplant(at, target) ? {text: 'Seedling transplanted.', decision: 'plant'}
        : {text: 'Choose an empty tilled tile.'};
    case 'basket': {
      const pickedKg = world.harvest(at, target);
      return pickedKg > 0 ? {text: pickedKg + ' kg picked.', pickedKg, decision: 'pick'}
        : {text: 'Choose a plant with ripe fruit and check your energy.'};
    }
  }
}
