import type {RunFeedback} from '../core/replay';
import type {TileRef, ViewModel} from '../core/types';

/**
 * Hints that ask for an action stop once the player has made that action, before or after the hint asked. Hints that
 * explain an observation (rolling, probe lag, the Water tab, the 06:00 decision, deep drying) are never skipped; only
 * the facilitator's hints switch turns them off (plan 7.4).
 */
export function tutorialHint(vm: ViewModel, feedback: RunFeedback, rolled: TileRef | undefined): string | undefined {
  const {practiced, valveUsed, observed, dripEnd, deepDrying} = feedback.tutorial;
  const {day} = vm.sky;
  if (day === 1) {
    if (!practiced.includes('pick') && vm.plants.some(plant => plant.ripeKg > 0)) {
      return 'Choose the basket and pick a ripe tomato from bed A.';
    }
    if (!practiced.includes('feel')) return 'Feel the soil in bed A. Use Feel soil or press E facing a bed tile.';
    if (!practiced.includes('can')) return 'Fill the can at the tank, then water a tile in bed A.';
    if (!practiced.includes('pump')) return 'Use the hand pump to add water to the tank.';
    if (vm.tier < 3 && !practiced.includes('tap')) return 'Open the tank tap and watch the drip line wet bed A.';
    if (vm.tier >= 3 && !valveUsed) {
      return 'Raise the phone and open the valve for 10 minutes. Lower the phone so the valve can answer.';
    }
    if (!practiced.includes('plant')) return 'Till one tile in bed B and transplant a seedling. Look for leaf rolling tomorrow.';
    return 'Go to the house after 18:00 to sleep.';
  }
  if (day === 2) {
    if (!practiced.includes('plant')) return 'Use the hoe and a seedling on bed B so you can watch a shallow transplant.';
    if (rolled) {
      const plant = vm.plants.find(value => value.at.x === rolled.x && value.at.y === rolled.y);
      if (plant?.stress === 'rolling') {
        return 'A bed B transplant is rolling its leaves. Its shallow roots reach only the top few centimetres, which dry first. '
          + 'Water it with the can and look at it again this evening.';
      }
      if (plant?.stress === 'turgid') return 'The leaves on the same bed B transplant have opened again.';
    }
  }
  if (day === 3 && vm.tier >= 1) {
    if (observed) {
      const change = observed.changeKpa;
      const difference = change === 0 ? 'unchanged (0 kPa)' : (change < 0 ? 'down ' : 'up ') + Math.abs(change) + ' kPa';
      return 'The 20 cm reading is ' + difference + ' since before the run. Check both readings again this evening.';
    }
    // Tutorial.observe compares only after a run that delivered water, stops at midnight and skips the readings taken
    // during sleep: state the conditions, promise nothing.
    return dripEnd !== null ? 'Water takes a while to sink in. If the run wet bed A and you are awake for a probe reading '
      + 'two or more hours after it ends and before midnight, the hint shows the 20 cm change.'
      : 'Check the 20 and 40 cm probe readings before and after a drip run.';
  }
  if (day === 4 && vm.tier >= 2) return 'Open the Water tab on the phone. Use the game calculator to turn ET0 and Kc into litres for bed A.';
  if (day === 5 && vm.tier >= 3 && !practiced.includes('plan')) {
    return 'Set a weekly plan for 07:00 on the phone. Visit the shared well while the plan waters bed A.';
  }
  if (day === 6 && vm.tier === 4) return 'Set a soil threshold and watering duration on the phone. Sleep and watch the 06:00 decision.';
  if (deepDrying && day === deepDrying.day) {
    return 'The 40 cm reading went from ' + Math.round(deepDrying.deepBeforeKpa) + ' to ' + Math.round(deepDrying.deepKpa)
      + ' kPa in two days, while the 20 cm reading is under the trigger\'s ' + deepDrying.thresholdKpa + ' kPa threshold. '
      + 'The runs are too short to reach deep, and the trigger only knows the depth it reads. '
      + 'To lengthen each run, raise Duration (min) under Trigger-based irrigation on the phone, '
      + 'then compare the 40 cm reading on the morning after the trigger\'s next run with the one before it.';
  }
}
