import type {Command} from './commands';
import type {Facing, PlayerActivity} from './labour';
import type {SurfaceBand} from './soil';
import type {FlowLiters, LitersBetween} from './water';
import type {DemoResponse} from './osi/types';

export type Tier = 0 | 1 | 2 | 3 | 4;
export type TileRef = Readonly<{x: number; y: number}>;
export type ToolId = 'hoe' | 'seedling' | 'can' | 'jerrycan' | 'basket';

export interface Scenario {
  readonly seed: number;
  readonly start: number;
  readonly tiers: readonly Tier[];
  readonly id: 'baseline' | 'dry-spell' | 'storm';
  readonly tutorial: boolean;
  readonly initial: Readonly<{
    readonly bedA: Readonly<{
      depletion: readonly [number, number, number, number, number];
      dayInStage: number;
      fruit: Readonly<{green: number; ripening: number; ripe: number}>;
    }>;
    readonly bedB: Readonly<{
      depletion: readonly [number, number, number, number, number];
      empty: true;
    }>;
    readonly tankLiters: number;
    /** Hand-dug well level at the slice start, at most the daily yield. */
    readonly wellLiters: number;
    /** Hand-dug well yield restored at 05:00 every day. */
    readonly wellYieldLiters: number;
    readonly energy: number;
  }>;
  readonly reference: Readonly<{
    supply: Readonly<{at: string; pumpToLiters: number; carryToLiters: number; carryMinEnergy: number}>;
    tiers: readonly ReferencePolicy[];
    tutorialDrip: Readonly<{day: number; at: string; minutes: number}>;
  }>;
}

export type ReferencePolicy =
  | Readonly<{tier: 0 | 1; kind: 'even-day-tap'; at: string; minutes: number}>
  | Readonly<{tier: 2; kind: 'verdict-tap'; at: string; verdict: 'irrigate_today'; maxMinutes: number}>
  | Readonly<{tier: 3; kind: 'weekly-plan'; at: string; weekdays: number; minutes: number}>
  | Readonly<{tier: 4; kind: 'swt-trigger'; sensor: 'SWT_1'; kPa: number; minutes: number}>;

type IrrigationEventBase = {
  at: number;
  expectationId: string;
  valveEui: string;
  zoneId: number | null;
};

export type IrrigationEvent = IrrigationEventBase & (
  | {kind: 'commanded'; trigger: string; durationSeconds: number}
  | {kind: 'opened'; flowRateLpm: number}
  | {kind: 'closed'; status: 'COMPLETED' | 'CANCELLED'; grossLiters: number | null}
  | {kind: 'cutoff'; closedAt: number; status: 'COMPLETED' | 'CANCELLED';
    winner: 'natural' | 'cutoff' | 'operator'; liters: FlowLiters}
);

export interface ReplayHeader {
  format: 1;
  build: string;
  scenario: string;
  seed: number;
  tier: Tier;
  start: number;
  pace: number;
  pauseWhilePhoneOpen: boolean;
  moistureLens: boolean;
  hints: boolean;
}

export interface Save {
  header: ReplayHeader;
  log: {tick: number; seq: number; cmd: Command}[];
  checkpoints: string[];
  cursor: {tick: number; seq: number; simNow: number};
}

export type TileTerrain = 'laterite' | 'grass' | 'path' | 'tilled';
export type TileFeature = 'house' | 'bed' | 'door' | 'lamp' | 'tank' | 'pump' | 'well'
  | 'shared-well' | 'acacia' | 'hedge' | 'rock' | 'tuft' | 'nursery'
  | 'probe' | 'gateway' | 'rain-gauge' | 'flow-meter' | 'valve';
export type CropSpriteStage = 'transplant' | 'vegetative' | 'flowering' | 'green-fruit' | 'ripe-fruit';
export type CropStressState = 'turgid' | 'rolling' | 'grey-green' | 'wilted' | 'dead';

export interface TileView {
  /** Tile coordinates, in metres on the 1 m grid. */
  readonly at: TileRef;
  /** Terrain key for the base or dual-grid atlas. */
  readonly terrain: TileTerrain;
  /** Stable per-tile variation for the terrain and detail sprites. */
  readonly variant: number;
  /** Planted or plantable plot, if any. */
  readonly bed: 'A' | 'B' | null;
  /** Object sprite anchored at this tile, if any. */
  readonly feature: TileFeature | null;
  /** Whether player movement can enter this tile. */
  readonly walkable: boolean;
  /** Surface tension category from the top 10 cm, or null outside the beds. */
  readonly surfaceBand: SurfaceBand | null;
  /** Surface water content from wilting point (0) to saturation (1), or null outside the beds. */
  readonly wetness: number | null;
}

export interface PlantView {
  /** Sprite anchor on the map. A tile represents the plants occupying 1 m². */
  readonly at: TileRef;
  /** Tomato base sprite key. */
  readonly stage: CropSpriteStage;
  /** Leaf palette and silhouette key. */
  readonly stress: CropStressState;
  /** Edge agronomic stage used for Kc. */
  readonly phenology: 'initial' | 'development' | 'mid_season' | 'late_season' | 'dormancy';
  /** Completed days since the current agronomic stage began. */
  readonly dayInStage: number;
  /** Current water stress coefficient on the game scale of 0–1. */
  readonly ks: number;
  /** Whether severe flowering stress is dropping flowers on this tile. */
  readonly flowerDrop: boolean;
  /** Ripe fruit mass available to pick on this tile, in kg. */
  readonly ripeKg: number;
}

export interface DripTileView {
  /** Pipe sprite anchor. */
  readonly at: TileRef;
  /** Connection mask with north = 1, east = 2, south = 4 and west = 8. */
  readonly connections: number;
  /** Whether this segment shows the wet or flowing variant. */
  readonly wet: boolean;
}

export interface CutoffView {
  /** Simulated time at which the cutoff CLOSE was sent, in epoch milliseconds. */
  readonly at: number;
  /** Meter estimate and delivered water for the cutoff run. */
  readonly liters: FlowLiters;
}

export interface WorldDayView {
  /** Farm civil date, YYYY-MM-DD. */
  readonly date: string;
  /** End of the record's interval in epoch milliseconds. */
  readonly at: number;
  /** Actual precipitation in mm. */
  readonly rainMm: number;
  /** Gross delivered litres, grouped by source. */
  readonly irrigationLiters: Readonly<{can: number; tap: number; valve: number}>;
  /** Runoff losses in litres across the two beds. */
  readonly runoffLiters: number;
  /** Deep percolation losses in litres across the two beds. */
  readonly percolationLiters: number;
  /** Difference between delivered drip litres and those applied to the bed. */
  readonly applicationLossLiters: number;
  /** Player energy spent moving, pumping or applying water. */
  readonly waterEnergy: number;
  /** Hand pump strokes from the hand-dug well into the tank, 20 L or what the well or tank allowed. */
  readonly pumpStrokes: number;
  /** Trips that fetched water from the shared well: carried jerrycans and containers filled there. */
  readonly carryTrips: number;
  /**
   * Bed A water held in the top metre of soil (its root zone), mean over the bed in mm: at the
   * start of the record's interval and at its end (for today's record, the last committed soil step).
   */
  readonly soilWaterMm: Readonly<{start: number; end: number}>;
  /** Simulated minutes spent on watering actions. */
  readonly waterMinutes: number;
  /** Mean Ks across crop tile time, or null when no living plants contributed. */
  readonly meanKs: number | null;
  /** Whether mean Ks fell below 0.8. */
  readonly stressDay: boolean;
  /** Picked tomato mass in kg. */
  readonly pickedKg: number;
  /** Rotted or killed ripe tomato mass in kg. */
  readonly lostKg: number;
  /** Harvested kg per m³ of delivered irrigation, or null before any irrigation. */
  readonly waterProductivityKgPerM3: number | null;
  /** Cutoffs sent on this local date. */
  readonly cutoffs: readonly CutoffView[];
}

export interface ViewModel {
  /** Current simulator time in epoch milliseconds. */
  readonly simNow: number;
  /** Fixed OSI tier for this run. */
  readonly tier: Tier;
  /** Whether the game is showing the phone overlay. */
  readonly phoneOpen: boolean;
  /** Tile map in row-major order, including its dimensions. */
  readonly map: Readonly<{
    /** Number of columns. */
    width: number;
    /** Number of rows. */
    height: number;
    /** Tiles ordered from the north-west corner. */
    tiles: readonly TileView[];
  }>;
  /** Visible crop tile sprites and game stress readings. */
  readonly plants: readonly PlantView[];
  /** Player sprite state. */
  readonly player: Readonly<{
    /** Map position in tiles. */
    at: TileRef;
    /** Direction of the sprite. */
    facing: Facing;
    /** Current sprite animation. */
    activity: PlayerActivity;
    /** Available energy out of the day's budget. */
    energy: number;
  }>;
  /** Source levels and limits shown on the farm and in the HUD. */
  readonly water: Readonly<{
    /** Available tank litres at simNow. */
    tankLiters: number;
    /** Tank capacity in litres. */
    tankCapacityLiters: number;
    /** Remaining hand-dug well yield in litres. The shared well is unlimited. */
    wellLiters: number;
    /** Hand-dug well daily yield in litres. */
    wellDailyLiters: number;
  }>;
  /** Calendar, sun and weather inputs to lighting, the daylight arc and effects. */
  readonly sky: Readonly<{
    /** Farm civil date, YYYY-MM-DD. */
    date: string;
    /** Slice day, starting at 1. */
    day: number;
    /** Local hour including fractional minutes and seconds, in [0, 24). */
    hour: number;
    /** Local hours for the daylight arc. */
    sunriseHour: number;
    sunsetHour: number;
    /** Fictional climate season. */
    season: 'Long Rains' | 'Cool Dry' | 'Short Rains' | 'Hot Dry';
    /** Actual current rain state. */
    raining: boolean;
    /** Actual rain intensity in mm/h for rain and splash particles. */
    rainMmPerHour: number;
  }>;
  /** Bed A drip geometry and animation state. WP4 supplies valve-driven wetness. */
  readonly dripLine: readonly DripTileView[];
  /** Valve animation and acknowledgement phase supplied by WP4. */
  readonly valve: 'absent' | 'closed' | 'pending' | 'open' | 'closing';
  /** HUD values for the tool belt, energy and daytime controls. */
  readonly hud: Readonly<{
    /** Available tool ids in display order. */
    tools: readonly ToolId[];
    /** Tool selected by the UI. */
    selectedTool: ToolId;
    /** Litres in the current watering can. */
    canLiters: number;
    /** Litres in the current jerrycan. */
    jerrycanLiters: number;
    /** Daily energy budget. */
    maxEnergy: number;
    /** Whether sleep can be dispatched. */
    canSleep: boolean;
    /** Whether the OSI phone can be raised for this tier. */
    canUsePhone: boolean;
    /** Whether the game moisture lens is enabled. */
    moistureLens: boolean;
    /** Whether the end of the slice has been reached. */
    sliceComplete: boolean;
  }>;
  /** Current partial day for the game report and the HUD. */
  readonly today: WorldDayView;
  /** Completed local days in chronological order for the slice report. */
  readonly daily: readonly WorldDayView[];
}

export interface Run {
  header: ReplayHeader;
  /** Dispatches queued commands, then advances up to eight ticks. */
  step(realMs: number): void;
  /** Appends to the run's command queue in arrival order. */
  apply(cmd: Command): void;
  /** Reads the current state without advancing time. */
  viewModel(): Readonly<ViewModel>;
  hash(): string;
}

export interface OsiAdapter {
  build(header: ReplayHeader, scenario: Scenario): void;
  advance(simMs: number): void;
  drainNow(): void;
  litersBetween: LitersBetween;
  drain(): IrrigationEvent[];
  /** The bridge dispatches queued commands before an allowed phone write. */
  request(method: string, path: string, body: unknown): DemoResponse;
  resetEnvironmentRecords(): void;
}
