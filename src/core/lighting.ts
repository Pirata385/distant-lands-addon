/** Day/night brightness for LOD particles (they are not lit by the engine). */

export interface LightInput {
  /** Ticks since sunrise, 0..24000 (Minecraft time of day). */
  timeOfDay: number;
  /** Rain strength 0..1. */
  rain: number;
  /** Thunder strength 0..1. */
  thunder: number;
  /** False when the doDayLightCycle game rule is off. */
  dayCycle: boolean;
  /** Day/night lighting setting. */
  enabled: boolean;
}

function frac(v: number): number {
  return v - Math.floor(v);
}

function celestialAngle(ticks: number): number {
  const d0 = frac(ticks / 24000 - 0.25);
  const d1 = 0.5 - Math.cos(d0 * Math.PI) / 2;
  return (d0 * 2 + d1) / 3;
}

/** Vanilla sky light factor (0.2 at night .. 1 at noon), reduced by rain and thunder. */
export function skyLight(ticks: number, rain: number, thunder: number): number {
  let f = 1 - (Math.cos(celestialAngle(ticks) * Math.PI * 2) * 2 + 0.2);
  f = 1 - Math.max(0, Math.min(1, f));
  f *= 1 - (rain * 5) / 16;
  f *= 1 - (thunder * 5) / 16;
  return f * 0.8 + 0.2;
}

/** Maps the sky light factor to a colour multiplier that matches how vanilla terrain darkens. */
export function lodBrightness(sky: number): number {
  return 0.1 + 0.9 * Math.pow(sky, 1.1);
}

/** Seconds over which the brightness slope is estimated (particles live roughly this long). */
const SLOPE_SECONDS = 10;

/**
 * Brightness at spawn time (`l0`) and its slope per second (`dl`): particles evaluate
 * `clamp(l0 + dl * age)` in Molang, so dusk and dawn are smooth without respawning.
 */
export function lightParams(i: LightInput): { l0: number; dl: number } {
  if (!i.enabled) return { l0: 1, dl: 0 };
  const b0 = lodBrightness(skyLight(i.timeOfDay, i.rain, i.thunder));
  if (!i.dayCycle) return { l0: b0, dl: 0 };
  const b1 = lodBrightness(skyLight(i.timeOfDay + SLOPE_SECONDS * 20, i.rain, i.thunder));
  return { l0: b0, dl: (b1 - b0) / SLOPE_SECONDS };
}
