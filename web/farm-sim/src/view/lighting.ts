import type {ViewModel} from './view-model';

export type LightKind = 'window' | 'door' | 'lamp' | 'spill' | 'sill' | 'device' | 'phone';

/** Rings that fade from `peak` to nothing, so a mask has no hard rim. */
function fade(peak: number, steps: number, power: number): number[] {
  return Array.from({length: steps}, (_, i) => Math.round(peak * (1 - i / steps) ** power));
}

/** Stepped masks drawn 1:1 into the light buffer, so the rings stay on the pixel grid. */
export const LIGHT_MASKS = {
  glow: {width: 48, height: 48, rings: [255, 195, 126, 72, 33, 13]},
  // A tight halo round a lit window: it lights the frame and sill, not the whole wall.
  halo: {width: 16, height: 14, rings: fade(190, 7, 1.7)},
  // Lamplight through the gap of the door standing ajar: narrow and tall.
  slit: {width: 10, height: 22, rings: fade(170, 7, 1.8)},
  // A pool on the ground in front of a lit opening, flattened by the low view angle,
  // with a long soft falloff and no visible rim.
  pool: {width: 22, height: 9, rings: fade(235, 11, 1.15)},
} as const;

type LightLook = {mask: keyof typeof LIGHT_MASKS; width: number; height: number; tint: string};

const LIGHT_LOOKS: Record<LightKind, LightLook> = {
  window: {mask: 'halo', width: 16, height: 14, tint: '#ffc66c'},
  door: {mask: 'slit', width: 10, height: 22, tint: '#ffbe66'},
  lamp: {mask: 'glow', width: 12, height: 12, tint: '#ffd27a'},
  spill: {mask: 'pool', width: 22, height: 9, tint: '#ffb85c'},
  // The small patch a window throws on the ground just in front of the wall.
  sill: {mask: 'pool', width: 12, height: 5, tint: '#ffb85c'},
  phone: {mask: 'glow', width: 26, height: 26, tint: '#86d7ff'},
  device: {mask: 'glow', width: 10, height: 10, tint: '#78ecc7'},
};

export function lightLook(kind: LightKind): LightLook {
  return LIGHT_LOOKS[kind];
}

type Rgb = readonly [number, number, number];
/** `key` multiplies light albedo and `shade` dark albedo; the composite blends them by luma. */
type Grade = {key: Rgb; shade: Rgb};

// Night stays cool and is lifted a little, so warm lamp light has something to stand against.
const NIGHT: Grade = {key: [.23, .28, .66], shade: [.23, .28, .66]};
// Dawn is pale and cool: a faint pink light over blue shade.
const DAWN: Grade = {key: [.98, .92, .90], shade: [.62, .72, 1.08]};
const NOON: Grade = {key: [1.02, 1.00, .94], shade: [.99, .98, .97]};
// Dusk light is about a fifth dimmer than noon and only a little warm, over violet shade:
// warm light hardly shows on orange ground, so the evening's colour sits in the shade and
// the long shadows. Blue stays high in both so the water keeps its colour.
const DUSK: Grade = {key: [.86, .74, .72], shade: [.58, .46, 1.10]};

// Sun-cast silhouettes multiply this colour over a cream mask of the caster (silhouetteFrame):
// neutral at midday, blue at dawn, and at dusk a blue that the violet shade turns violet.
const SHADOW_NOON: Rgb = [.231, .165, .200];
const SHADOW_DAWN: Rgb = [.40, .48, .98];
const SHADOW_DUSK: Rgb = [.22, .34, 1.00];

const SEASON: Record<ViewModel['sky']['season'], Rgb> = {
  'Hot Dry': [1.02, 1.00, .95],
  'Cool Dry': [.96, .98, 1.02],
  'Long Rains': [.95, 1.01, 1.04],
  'Short Rains': [.99, 1.01, 1.02],
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function ease(value: number) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  if (amount === 0) return from;
  if (amount === 1) return to;
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

function mixGrade(from: Grade, to: Grade, amount: number): Grade {
  return {key: mix(from.key, to.key, amount), shade: mix(from.shade, to.shade, amount)};
}

function hex(rgb: Rgb) {
  return rgb.reduce((value, channel) => value * 256 + Math.round(clamp01(channel) * 255), 0);
}

export function lightingAt(sky: ViewModel['sky']) {
  const {hour, sunriseHour, sunsetHour} = sky;
  const dawnAt = sunriseHour + .5;
  const duskAt = sunsetHour - .5;
  const noon = (sunriseHour + sunsetHour) / 2;
  let daylight: Grade;
  // How far the grade has gone towards night: drives the hose's night shade.
  let darkness = 0;
  if (hour < dawnAt) {
    const t = ease((hour - sunriseHour + .75) / 1.25);
    daylight = mixGrade(NIGHT, DAWN, t);
    darkness = 1 - t;
  } else if (hour < noon) {
    daylight = mixGrade(DAWN, NOON, ease((hour - dawnAt) / (noon - dawnAt)));
  } else if (hour < duskAt) {
    daylight = mixGrade(NOON, DUSK, ease((hour - noon) / (duskAt - noon)));
  } else {
    const t = ease((hour - duskAt) / 1.25);
    daylight = mixGrade(DUSK, NIGHT, t);
    darkness = t;
  }

  const rain = sky.raining ? .18 + .16 * clamp01(sky.rainMmPerHour / 12) : 0;
  const season = SEASON[sky.season];
  const weather = (rgb: Rgb): Rgb => [
    rgb[0] * season[0] * (1 - rain),
    rgb[1] * season[1] * (1 - rain * .83),
    rgb[2] * season[2] * (1 - rain * .48),
  ];
  const phase = clamp01((hour - sunriseHour) / (sunsetHour - sunriseHour));
  const elevation = Math.sin(Math.PI * phase);
  const directSun = ease(elevation * 8) * (1 - rain * 2);
  // Low sun colours the cast shadows and makes them denser, the evening ones most, so dawn
  // stays the paler of the two.
  const golden = 1 - ease((elevation - .1) / .4);
  const shadowTint = mix(SHADOW_NOON, hour < noon ? SHADOW_DAWN : SHADOW_DUSK, golden);
  return {
    ambient: weather(daylight.key),
    shade: weather(daylight.shade),
    darkness,
    // Lamps are lit from half an hour before sunset; the lit frame shows above 0.15.
    windowGlow: Math.max(1 - ease((hour - sunriseHour + .55) / .85), ease((hour - sunsetHour + 1) / 1.6)),
    shadow: {
      opacity: directSun * (.29 + (hour < noon ? .27 : .38) * golden),
      blobOpacity: .16 + directSun * .13,
      tint: hex(shadowTint),
      // Positive X points east. Long shadows are capped per caster.
      east: -Math.cos(Math.PI * phase),
      lengthPerHeight: (1 - elevation) / Math.max(.08, elevation),
    },
  };
}

type Lighting = ReturnType<typeof lightingAt>;

/** Atlas id of the single-colour mask that a caster's frame throws as its long shadow. */
export function silhouetteFrame(id: string) {
  return 'shadow.' + id;
}

/**
 * CPU copy of the composite in renderer.ts for one albedo pixel (0-255) with no lamp light:
 * luma below 0.2 takes the shade colour, above 0.66 the key, smoothly between. The art
 * review and the lighting tests use it; keep it in step with COMPOSITE_FRAGMENT.
 */
export function gradePixel(albedo: Rgb, light: Pick<Lighting, 'ambient' | 'shade'>): Rgb {
  const t = ease(((.299 * albedo[0] + .587 * albedo[1] + .114 * albedo[2]) / 255 - .2) / .46);
  const channel = (i: number) =>
    Math.round(Math.min(255, albedo[i] * (light.shade[i] + (light.ambient[i] - light.shade[i]) * t)));
  return [channel(0), channel(1), channel(2)];
}

/** CPU copy of one cast-shadow pixel: the tinted mask multiplied into the ground at the shadow's opacity. */
export function shadowPixel(ground: Rgb, mask: Rgb, shadow: Pick<Lighting['shadow'], 'tint' | 'opacity'>): Rgb {
  const tint = [shadow.tint >> 16 & 255, shadow.tint >> 8 & 255, shadow.tint & 255];
  const channel = (i: number) =>
    Math.round(ground[i] * (1 - shadow.opacity + shadow.opacity * mask[i] / 255 * tint[i] / 255));
  return [channel(0), channel(1), channel(2)];
}
