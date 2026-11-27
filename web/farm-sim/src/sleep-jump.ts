import type {FarmRun} from './core/replay';

/** Run overnight physics one simulation boundary per task while the sleep screen holds input. */
export class SleepJump {
  private readonly steps: Generator<void>;

  constructor(readonly run: FarmRun) {
    this.steps = run.sleepSteps();
  }

  advance(): boolean {
    return this.steps.next().done === true;
  }
}
