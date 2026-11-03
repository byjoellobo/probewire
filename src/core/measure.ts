/** Measurements derived from logic data around a point of interest. */
import type { LogicPyramid } from './pyramid';

export interface PulseMeasurement {
  readonly channel: number;
  readonly level: 0 | 1;
  /** First sample of the pulse under the probe. */
  readonly start: number;
  /** Sample after the pulse ends (or capture end). */
  readonly end: number;
  /** True when the pulse runs into the start or end of the capture. */
  readonly truncated: boolean;
  readonly widthSeconds: number;
  /** Full period (this pulse plus the following opposite pulse), when known. */
  readonly periodSeconds?: number;
  readonly frequency?: number;
  /** Fraction of the period spent high. */
  readonly dutyCycle?: number;
}

export function measurePulse(pyr: LogicPyramid, channel: number, sample: number, sampleRate: number): PulseMeasurement | undefined {
  const n = pyr.length;
  const s = Math.floor(sample);
  if (s < 0 || s >= n) return undefined;
  const mask = (1 << channel) >>> 0;
  const level = pyr.bit(channel, s);
  const prev = pyr.findPrevChange(mask, s);
  const next = pyr.findChange(mask, s);
  const start = prev + 1;
  const end = next < 0 ? n : next;
  const truncated = prev < 0 || next < 0;
  const widthSeconds = (end - start) / sampleRate;
  if (truncated) return { channel, level, start, end, truncated, widthSeconds };
  const following = pyr.findChange(mask, end);
  if (following < 0) return { channel, level, start, end, truncated, widthSeconds };
  const periodSeconds = (following - start) / sampleRate;
  const highSeconds = level ? widthSeconds : (following - end) / sampleRate;
  return {
    channel,
    level,
    start,
    end,
    truncated,
    widthSeconds,
    periodSeconds,
    frequency: 1 / periodSeconds,
    dutyCycle: highSeconds / periodSeconds,
  };
}

/** Number of rising and falling edges of a channel in [start, end). */
export function countEdges(pyr: LogicPyramid, channel: number, start: number, end: number): number {
  const mask = (1 << channel) >>> 0;
  let count = 0;
  let i = Math.max(0, Math.floor(start));
  const stop = Math.min(pyr.length, Math.ceil(end));
  while (i < stop) {
    const next = pyr.findChange(mask, i, stop);
    if (next < 0) break;
    count++;
    i = next;
  }
  return count;
}
