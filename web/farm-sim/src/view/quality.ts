const TIERS = {
  standard: {fps: 60, particleLimit: 400},
  low: {fps: 30, particleLimit: 150},
} as const;

export type QualityTier = keyof typeof TIERS;
export const qualitySettings = (tier: QualityTier) => TIERS[tier];

export function percentile95(samples: readonly number[]) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * .95) - 1];
}

/** Start at the memory hint and let two seconds of visible frames settle the choice. */
export class FrameQuality {
  private readonly samples: number[] = [];
  private firstFrameAt: number | undefined;
  private previousFrameAt: number | undefined;
  private tier: QualityTier;

  constructor(deviceMemory?: number) {
    this.tier = deviceMemory !== undefined && deviceMemory <= 2 ? 'low' : 'standard';
  }

  get current() {
    return this.tier;
  }

  observe(at: number, workMs: number) {
    if (this.tier === 'low' || this.firstFrameAt === Infinity) return;
    // Time spent doing the previous frame's work is part of the probe. Restart only
    // after a long gap outside measured work, such as a suspended tab.
    const previousWorkMs = this.samples[this.samples.length - 1] ?? 0;
    const idleGap = at - (this.previousFrameAt ?? at) - previousWorkMs;
    if (idleGap > 250) {
      this.firstFrameAt = undefined;
      this.samples.length = 0;
    }
    this.previousFrameAt = at;
    this.firstFrameAt ??= at;
    this.samples.push(workMs);
    if (at - this.firstFrameAt >= 2_000) {
      if (percentile95(this.samples) > 6) this.tier = 'low';
      this.firstFrameAt = Infinity;
      this.samples.length = 0;
    }
  }
}

/** Absolute frame slots avoid drifting to 40 fps on a 60 Hz display. */
export function frameSlot(elapsedMs: number, tier: QualityTier) {
  return Math.floor((elapsedMs + 1) * qualitySettings(tier).fps / 1_000);
}
