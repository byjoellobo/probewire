/**
 * Horizontal viewport math. A viewport maps sample indices to CSS pixels:
 *   x = (sample - start) / samplesPerPixel
 * All functions are pure and return new viewports.
 */
import { formatTickTime } from '../core/units';

export interface Viewport {
  /** Sample index (fractional) at x = 0. */
  readonly start: number;
  /** Samples per CSS pixel. Below 1 means zoomed in past one sample per pixel. */
  readonly spp: number;
}

/** Deepest zoom: 64 pixels per sample. */
export const MIN_SPP = 1 / 64;

export function sampleToX(v: Viewport, sample: number): number {
  return (sample - v.start) / v.spp;
}

export function xToSample(v: Viewport, x: number): number {
  return v.start + x * v.spp;
}

/** Widest zoom shows the whole capture. */
export function maxSpp(sampleCount: number, width: number): number {
  return Math.max(MIN_SPP, sampleCount / Math.max(1, width));
}

export function clampViewport(v: Viewport, sampleCount: number, width: number): Viewport {
  const spp = Math.min(Math.max(v.spp, MIN_SPP), maxSpp(sampleCount, width));
  const visible = width * spp;
  const maxStart = Math.max(0, sampleCount - visible);
  const start = Math.min(Math.max(v.start, 0), maxStart);
  return { start, spp };
}

export function fitViewport(sampleCount: number, width: number): Viewport {
  return { start: 0, spp: maxSpp(sampleCount, width) };
}

/** Zooms by `factor` (>1 zooms out) keeping the sample under `anchorX` fixed. */
export function zoomAt(v: Viewport, factor: number, anchorX: number, sampleCount: number, width: number): Viewport {
  const anchor = xToSample(v, anchorX);
  const spp = Math.min(Math.max(v.spp * factor, MIN_SPP), maxSpp(sampleCount, width));
  return clampViewport({ start: anchor - anchorX * spp, spp }, sampleCount, width);
}

export function panBy(v: Viewport, dxPixels: number, sampleCount: number, width: number): Viewport {
  return clampViewport({ start: v.start - dxPixels * v.spp, spp: v.spp }, sampleCount, width);
}

export function centerOn(v: Viewport, sample: number, sampleCount: number, width: number): Viewport {
  return clampViewport({ start: sample - (width / 2) * v.spp, spp: v.spp }, sampleCount, width);
}

/** Shows [s0, s1) with a small margin on both sides. */
export function zoomToRange(s0: number, s1: number, sampleCount: number, width: number): Viewport {
  const span = Math.max(1, s1 - s0);
  const margin = span * 0.1;
  const spp = (span + 2 * margin) / Math.max(1, width);
  return clampViewport({ start: s0 - margin, spp }, sampleCount, width);
}

export interface Tick {
  readonly x: number;
  readonly label: string;
  readonly major: boolean;
}

/**
 * Ruler ticks on a 1-2-5 grid, labelled relative to `originSample`
 * (usually the trigger). Major ticks carry labels; minor ticks subdivide.
 */
export function timeTicks(v: Viewport, width: number, sampleRate: number, originSample = 0, minSpacingPx = 96): Tick[] {
  const secondsPerPx = v.spp / sampleRate;
  const step = niceStep(minSpacingPx * secondsPerPx);
  const minor = step / 5;
  const t0 = (v.start - originSample) / sampleRate;
  const t1 = (xToSample(v, width) - originSample) / sampleRate;
  const magnitude = Math.max(Math.abs(t0), Math.abs(t1));
  const ticks: Tick[] = [];
  const first = Math.floor(t0 / minor);
  const last = Math.ceil(t1 / minor);
  if (last - first > 2000) return ticks;
  for (let k = first; k <= last; k++) {
    const t = k * minor;
    const x = sampleToX(v, originSample + t * sampleRate);
    if (x < -1 || x > width + 1) continue;
    const major = k % 5 === 0;
    ticks.push({ x, major, label: major ? formatTickTime(t, step, magnitude) : '' });
  }
  return ticks;
}

/** Smallest value of the form {1, 2, 5} x 10^n that is >= `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= raw * (1 - 1e-9)) return m * base;
  }
  return 10 * base;
}
