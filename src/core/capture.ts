/**
 * Capture data model.
 *
 * Logic samples are stored packed: one unsigned word per sample, bit N of the
 * word is the level of logic channel N. This matches the layout used by
 * sigrok's .sr files (unitsize bytes per sample, little-endian), so import and
 * export need no reshuffling.
 *
 * Captures are treated as immutable once built: typed arrays are never written
 * after construction, and updates produce a new Capture object.
 */

export type SampleWords = Uint8Array | Uint16Array | Uint32Array;

export interface LogicChannel {
  /** Bit position inside the sample word. */
  readonly index: number;
  readonly name: string;
}

export interface AnalogChannel {
  readonly name: string;
  readonly unit: string;
  /** One value per sample, same timebase as the logic samples. */
  readonly data: Float32Array;
}

export interface Capture {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  /** Samples per second. */
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly channels: readonly LogicChannel[];
  readonly samples: SampleWords;
  readonly analog: readonly AnalogChannel[];
  /** Sample index of the trigger point, if the device reported one. */
  readonly triggerSample?: number;
  /** Sample indices where a new burst starts (gusmanb burst captures). */
  readonly burstStarts?: readonly number[];
  /** Measured dead time before each burst in burstStarts, in nanoseconds. */
  readonly burstGapsNs?: readonly number[];
  /** Human-readable description of where this capture came from. */
  readonly source: string;
}

export const MAX_LOGIC_CHANNELS = 32;

/** Bytes needed per sample word to hold `channelBits` logic channels. */
export function wordBytesFor(channelBits: number): 1 | 2 | 4 {
  if (channelBits <= 8) return 1;
  if (channelBits <= 16) return 2;
  if (channelBits <= 32) return 4;
  throw new RangeError(`At most ${MAX_LOGIC_CHANNELS} logic channels are supported (got ${channelBits})`);
}

export function allocWords(sampleCount: number, wordBytes: 1 | 2 | 4): SampleWords {
  if (wordBytes === 1) return new Uint8Array(sampleCount);
  if (wordBytes === 2) return new Uint16Array(sampleCount);
  return new Uint32Array(sampleCount);
}

/** Highest bit index used by any channel, plus one. */
export function channelBitWidth(channels: readonly LogicChannel[]): number {
  let width = 0;
  for (const ch of channels) width = Math.max(width, ch.index + 1);
  return width;
}

export function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultChannelNames(count: number, prefix = 'D'): LogicChannel[] {
  return Array.from({ length: count }, (_, i) => ({ index: i, name: `${prefix}${i}` }));
}

export interface CaptureInit {
  name?: string;
  sampleRate: number;
  channels: readonly LogicChannel[];
  samples: SampleWords;
  analog?: readonly AnalogChannel[];
  triggerSample?: number;
  burstStarts?: readonly number[];
  burstGapsNs?: readonly number[];
  source: string;
  id?: string;
  createdAt?: number;
}

/** Validates and builds a Capture. Throws on inconsistent input. */
export function createCapture(init: CaptureInit): Capture {
  if (!Number.isFinite(init.sampleRate) || init.sampleRate <= 0) {
    throw new RangeError(`Sample rate must be a positive number (got ${init.sampleRate})`);
  }
  const sampleCount = init.samples.length;
  const width = channelBitWidth(init.channels);
  if (width > init.samples.BYTES_PER_ELEMENT * 8) {
    throw new RangeError(`Channel bit ${width - 1} does not fit in a ${init.samples.BYTES_PER_ELEMENT}-byte sample word`);
  }
  for (const a of init.analog ?? []) {
    if (a.data.length !== sampleCount) {
      throw new RangeError(`Analog channel ${a.name} has ${a.data.length} samples, expected ${sampleCount}`);
    }
  }
  if (init.triggerSample !== undefined && (init.triggerSample < 0 || init.triggerSample > sampleCount)) {
    throw new RangeError(`Trigger sample ${init.triggerSample} is outside the capture`);
  }
  const createdAt = init.createdAt ?? Date.now();
  return {
    id: init.id ?? makeId(),
    name: init.name ?? defaultCaptureName(createdAt),
    createdAt,
    sampleRate: init.sampleRate,
    sampleCount,
    channels: init.channels,
    samples: init.samples,
    analog: init.analog ?? [],
    triggerSample: init.triggerSample,
    burstStarts: init.burstStarts,
    burstGapsNs: init.burstGapsNs,
    source: init.source,
  };
}

export function defaultCaptureName(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `Capture ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function withChannelName(capture: Capture, index: number, name: string): Capture {
  return {
    ...capture,
    channels: capture.channels.map((ch) => (ch.index === index ? { ...ch, name } : ch)),
  };
}

export function renamed(capture: Capture, name: string): Capture {
  return { ...capture, name };
}

/** Duration of the capture in seconds. */
export function captureDuration(capture: Capture): number {
  return capture.sampleCount / capture.sampleRate;
}
