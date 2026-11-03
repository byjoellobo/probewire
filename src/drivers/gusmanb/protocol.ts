/**
 * Wire protocol of the gusmanb Raspberry Pi Pico logic analyzer (firmware V6_x).
 *
 * Host -> device frames: 55 AA <escaped payload> AA 55, payload = [cmd][body].
 * Payload bytes AA, 55 and F0 are sent as F0 followed by (byte ^ F0).
 * Device -> host: ASCII lines, then raw binary capture data.
 *
 * Implemented from a description of the protocol; no code from the GPL-3.0
 * gusmanb/logicanalyzer project is included.
 */
import { allocWords, type SampleWords } from '../../core/capture';

export const GUSMANB_USB_FILTER = { usbVendorId: 0x1209, usbProductId: 0x3020 } as const;

export const CMD_DEVICE_INFO = 0;
export const CMD_START_CAPTURE = 1;
export const CMD_BOOTLOADER = 4;
export const CMD_BLINK_ON = 5;
export const CMD_BLINK_OFF = 6;
/** Any single byte cancels a running capture; the official host sends 0xFF. */
export const CANCEL_BYTE = 0xff;

const FRAME_START = [0x55, 0xaa];
const FRAME_END = [0xaa, 0x55];
const ESCAPE = 0xf0;
/** The firmware's receive buffer; frames larger than this overflow it. */
export const MAX_FRAME_BYTES = 128;

export const CAPTURE_REQUEST_SIZE = 48;
export const EXTERNAL_TRIGGER_CHANNEL = 24;

export function buildFrame(command: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out: number[] = [...FRAME_START];
  const payload = [command, ...body];
  for (const b of payload) {
    if (b === 0xaa || b === 0x55 || b === ESCAPE) out.push(ESCAPE, b ^ ESCAPE);
    else out.push(b);
  }
  out.push(...FRAME_END);
  if (out.length > MAX_FRAME_BYTES) throw new RangeError(`Frame of ${out.length} bytes exceeds the device's ${MAX_FRAME_BYTES}-byte buffer`);
  return new Uint8Array(out);
}

/** Inverse of buildFrame. Returns the unescaped payload, or undefined if malformed. */
export function parseFrame(frame: Uint8Array): Uint8Array | undefined {
  if (frame.length < 5) return undefined;
  if (frame[0] !== 0x55 || frame[1] !== 0xaa) return undefined;
  if (frame[frame.length - 2] !== 0xaa || frame[frame.length - 1] !== 0x55) return undefined;
  const out: number[] = [];
  for (let i = 2; i < frame.length - 2; i++) {
    if (frame[i] === ESCAPE) {
      i++;
      if (i >= frame.length - 2) return undefined;
      out.push(frame[i] ^ ESCAPE);
    } else out.push(frame[i]);
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Device info
// ---------------------------------------------------------------------------

export interface GusmanbDeviceInfo {
  readonly versionLine: string;
  readonly board: string;
  readonly major: number;
  readonly minor: number;
  readonly maxFrequency: number;
  readonly blastFrequency: number;
  readonly bufferBytes: number;
  readonly channelCount: number;
  /** Turbo builds overclock to 400 MHz and report a 200 MHz max sample rate. */
  readonly turbo: boolean;
}

export class HandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandshakeError';
  }
}

/** Parses the five handshake lines sent in reply to CMD_DEVICE_INFO. */
export function parseDeviceInfo(lines: readonly string[]): GusmanbDeviceInfo {
  if (lines.length < 5) throw new HandshakeError(`Expected 5 handshake lines, got ${lines.length}`);
  const [versionLine, freqLine, blastLine, bufferLine, channelsLine] = lines.map((l) => l.trim());
  const version = /^LOGIC_ANALYZER_(.*?)_?V(\d+)_(\d+)$/.exec(versionLine);
  if (!version) throw new HandshakeError(`Unrecognised firmware banner "${versionLine}"`);
  const major = Number(version[2]);
  const minor = Number(version[3]);
  if (major < 6) {
    throw new HandshakeError(`Firmware V${major}_${minor} is too old. Flash firmware V6_0 or newer from the gusmanb/logicanalyzer releases.`);
  }
  const num = (line: string, key: string): number => {
    const m = new RegExp(`^${key}:(\\d+)$`).exec(line);
    if (!m) throw new HandshakeError(`Expected "${key}:<number>", got "${line}"`);
    return Number(m[1]);
  };
  const maxFrequency = num(freqLine, 'FREQ');
  return {
    versionLine,
    board: version[1].replace(/_$/, '') || 'PICO',
    major,
    minor,
    maxFrequency,
    blastFrequency: num(blastLine, 'BLASTFREQ'),
    bufferBytes: num(bufferLine, 'BUFFER'),
    channelCount: num(channelsLine, 'CHANNELS'),
    turbo: maxFrequency >= 200_000_000,
  };
}

// ---------------------------------------------------------------------------
// Capture request
// ---------------------------------------------------------------------------

export type CaptureMode = 0 | 1 | 2;

export type GusmanbTrigger =
  | { readonly type: 'edge'; readonly channel: number; readonly falling: boolean; readonly bursts: number; readonly measureBursts: boolean }
  | { readonly type: 'blast'; readonly channel: number; readonly falling: boolean }
  | { readonly type: 'complex' | 'fast'; readonly baseChannel: number; readonly bitCount: number; readonly pattern: number };

export interface GusmanbCaptureConfig {
  /** Channel numbers 0-23 in the order they should appear (bit i = channels[i]). */
  readonly channels: readonly number[];
  readonly sampleRate: number;
  readonly preSamples: number;
  /** Samples after the trigger, per burst. */
  readonly postSamples: number;
  readonly trigger: GusmanbTrigger;
}

/** The raw struct fields, before trigger-latency compensation is applied. */
export interface CaptureRequestFields {
  readonly triggerType: 0 | 1 | 2 | 3;
  readonly trigger: number;
  readonly invertedOrCount: number;
  readonly triggerValue: number;
  readonly channels: readonly number[];
  readonly frequency: number;
  readonly preSamples: number;
  readonly postSamples: number;
  readonly loopCount: number;
  readonly measure: boolean;
  readonly captureMode: CaptureMode;
}

const TRIGGER_TYPE_CODE = { edge: 0, complex: 1, fast: 2, blast: 3 } as const;

export function captureModeFor(channels: readonly number[]): CaptureMode {
  const max = Math.max(...channels);
  if (max < 8) return 0;
  if (max < 16) return 1;
  return 2;
}

export function bytesPerSample(mode: CaptureMode): 1 | 2 | 4 {
  return mode === 0 ? 1 : mode === 1 ? 2 : 4;
}

/**
 * Pattern triggers are detected a few CPU cycles late. The device is asked for
 * extra pre-trigger samples (and fewer post-trigger ones) so the returned data
 * lines up with the actual trigger point. `latencyCycles` is 3 for fast and 5
 * for complex triggers, measured in max-frequency sample periods.
 */
export function patternTriggerOffset(type: 'complex' | 'fast', sampleRate: number, maxFrequency: number): number {
  const latencyCycles = type === 'fast' ? 3 : 5;
  return Math.round((latencyCycles * sampleRate) / maxFrequency + 0.3);
}

/** Translates a user-level config into the struct fields the firmware expects. */
export function requestFields(config: GusmanbCaptureConfig, info: GusmanbDeviceInfo): CaptureRequestFields {
  const t = config.trigger;
  const base = {
    channels: config.channels,
    frequency: config.sampleRate,
    captureMode: captureModeFor(config.channels),
  };
  switch (t.type) {
    case 'edge':
      return {
        ...base,
        triggerType: TRIGGER_TYPE_CODE.edge,
        trigger: t.channel,
        invertedOrCount: t.falling ? 1 : 0,
        triggerValue: 0,
        preSamples: config.preSamples,
        postSamples: config.postSamples,
        loopCount: t.bursts,
        measure: t.measureBursts && t.bursts > 0,
      };
    case 'blast':
      return {
        ...base,
        triggerType: TRIGGER_TYPE_CODE.blast,
        trigger: t.channel,
        invertedOrCount: t.falling ? 1 : 0,
        triggerValue: 0,
        preSamples: 0,
        postSamples: config.postSamples,
        loopCount: 0,
        measure: false,
      };
    case 'complex':
    case 'fast': {
      const offset = patternTriggerOffset(t.type, config.sampleRate, info.maxFrequency);
      return {
        ...base,
        triggerType: TRIGGER_TYPE_CODE[t.type],
        trigger: t.baseChannel,
        invertedOrCount: t.bitCount,
        triggerValue: t.pattern & 0xffff,
        preSamples: config.preSamples + offset,
        postSamples: Math.max(1, config.postSamples - offset),
        loopCount: 0,
        measure: false,
      };
    }
  }
}

/** Serialises CAPTURE_REQUEST (48 bytes, natural alignment, little-endian). */
export function encodeCaptureRequest(f: CaptureRequestFields): Uint8Array {
  const buf = new Uint8Array(CAPTURE_REQUEST_SIZE);
  const v = new DataView(buf.buffer);
  v.setUint8(0, f.triggerType);
  v.setUint8(1, f.trigger);
  v.setUint8(2, f.invertedOrCount);
  v.setUint16(4, f.triggerValue, true);
  f.channels.forEach((ch, i) => v.setUint8(6 + i, ch));
  v.setUint8(30, f.channels.length);
  v.setUint32(32, f.frequency, true);
  v.setUint32(36, f.preSamples, true);
  v.setUint32(40, f.postSamples, true);
  v.setUint8(44, f.loopCount);
  v.setUint8(45, f.measure ? 1 : 0);
  v.setUint8(46, f.captureMode);
  return buf;
}

export function decodeCaptureRequest(buf: Uint8Array): CaptureRequestFields {
  if (buf.length < CAPTURE_REQUEST_SIZE) throw new RangeError('CAPTURE_REQUEST is 48 bytes');
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = v.getUint8(30);
  return {
    triggerType: v.getUint8(0) as 0 | 1 | 2 | 3,
    trigger: v.getUint8(1),
    invertedOrCount: v.getUint8(2),
    triggerValue: v.getUint16(4, true),
    channels: Array.from(buf.subarray(6, 6 + count)),
    frequency: v.getUint32(32, true),
    preSamples: v.getUint32(36, true),
    postSamples: v.getUint32(40, true),
    loopCount: v.getUint8(44),
    measure: v.getUint8(45) === 1,
    captureMode: v.getUint8(46) as CaptureMode,
  };
}

// ---------------------------------------------------------------------------
// Limits and validation
// ---------------------------------------------------------------------------

export interface GusmanbLimits {
  readonly totalSamples: number;
  readonly minPre: number;
  readonly maxPre: number;
  readonly minPost: number;
  readonly maxPost: number;
  readonly minFrequency: number;
  readonly maxFrequency: number;
}

export function limitsFor(info: GusmanbDeviceInfo, mode: CaptureMode): GusmanbLimits {
  const totalSamples = Math.floor(info.bufferBytes / bytesPerSample(mode));
  return {
    totalSamples,
    minPre: 2,
    maxPre: Math.floor(totalSamples / 10),
    minPost: 2,
    maxPost: totalSamples - 2,
    minFrequency: Math.floor((info.maxFrequency * 2) / 65535),
    maxFrequency: info.maxFrequency,
  };
}

/** Returns a list of human-readable problems; empty means the config is valid. */
export function validateConfig(config: GusmanbCaptureConfig, info: GusmanbDeviceInfo): string[] {
  const errors: string[] = [];
  const chans = config.channels;
  if (chans.length === 0) errors.push('Select at least one channel.');
  if (chans.length > info.channelCount) errors.push(`At most ${info.channelCount} channels.`);
  if (chans.some((c) => !Number.isInteger(c) || c < 0 || c >= info.channelCount)) {
    errors.push(`Channel numbers must be 0 to ${info.channelCount - 1}.`);
  }
  if (new Set(chans).size !== chans.length) errors.push('Each channel can only be selected once.');
  if (errors.length > 0) return errors;

  const t = config.trigger;
  const post = config.postSamples;
  const integers: Array<[string, unknown]> = [
    ['Sample rate', config.sampleRate],
    ['Pre-trigger samples', config.preSamples],
    ['Post-trigger samples', post],
    ...(t.type === 'complex' || t.type === 'fast'
      ? ([
          ['Pattern length', t.bitCount],
          ['Pattern channel', t.baseChannel],
          ['Pattern', t.pattern],
        ] as Array<[string, unknown]>)
      : []),
  ];
  for (const [label, value] of integers) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) errors.push(`${label} must be a whole number.`);
  }
  if (errors.length > 0) return errors;

  const limits = limitsFor(info, captureModeFor(chans));

  if (t.type === 'blast') {
    if (config.sampleRate !== info.blastFrequency) errors.push(`Blast mode always samples at ${info.blastFrequency} Hz.`);
    if (post < 2 || post > limits.totalSamples) errors.push(`Blast captures take 2 to ${limits.totalSamples} samples.`);
    checkTriggerChannel(t.channel, info, errors);
    return errors;
  }

  if (config.sampleRate < limits.minFrequency || config.sampleRate > limits.maxFrequency) {
    errors.push(`Sample rate must be between ${limits.minFrequency} Hz and ${limits.maxFrequency} Hz.`);
  }
  if (config.preSamples < limits.minPre || config.preSamples > limits.maxPre) {
    errors.push(`Pre-trigger samples must be ${limits.minPre} to ${limits.maxPre}.`);
  }
  if (post < limits.minPost || post > limits.maxPost) {
    errors.push(`Post-trigger samples must be ${limits.minPost} to ${limits.maxPost}.`);
  }

  if (t.type === 'edge') {
    checkTriggerChannel(t.channel, info, errors);
    const maxBursts = t.measureBursts ? 253 : 254;
    if (!Number.isInteger(t.bursts) || t.bursts < 0 || t.bursts > maxBursts) errors.push(`Extra bursts must be 0 to ${maxBursts}.`);
    if (config.preSamples + post * (t.bursts + 1) > limits.totalSamples) {
      errors.push(`Pre + post x bursts must fit in ${limits.totalSamples} samples.`);
    }
  } else {
    const maxBits = t.type === 'fast' ? 5 : 16;
    if (t.bitCount < 1 || t.bitCount > maxBits) errors.push(`${t.type === 'fast' ? 'Fast' : 'Complex'} triggers match 1 to ${maxBits} bits.`);
    if (t.baseChannel < 0 || t.baseChannel + t.bitCount > maxBits) {
      errors.push(`The pattern must sit within channels 1 to ${maxBits}.`);
    }
    if (config.preSamples + post > limits.totalSamples) errors.push(`Pre + post must fit in ${limits.totalSamples} samples.`);
  }
  return errors;
}

function checkTriggerChannel(channel: number, info: GusmanbDeviceInfo, errors: string[]): void {
  const onChannel = Number.isInteger(channel) && channel >= 0 && channel < info.channelCount;
  if (!onChannel && channel !== EXTERNAL_TRIGGER_CHANNEL) {
    errors.push(`Trigger channel must be 1 to ${info.channelCount}, or the external trigger input.`);
  }
}

// ---------------------------------------------------------------------------
// Capture data
// ---------------------------------------------------------------------------

/** Converts raw little-endian sample bytes into sample words. */
export function decodeSamples(raw: Uint8Array, mode: CaptureMode, count: number): SampleWords {
  const bps = bytesPerSample(mode);
  const words = allocWords(count, bps);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (bps === 1) {
    words.set(raw.subarray(0, count));
  } else if (bps === 2) {
    for (let i = 0; i < count; i++) words[i] = view.getUint16(i * 2, true);
  } else {
    for (let i = 0; i < count; i++) words[i] = view.getUint32(i * 4, true) & 0x00ffffff;
  }
  return words;
}

/**
 * Burst timestamps are SysTick snapshots: low 24 bits count down at the CPU
 * clock, high 8 bits count rollovers. Returns elapsed ticks as a monotonic
 * 32-bit value.
 */
export function stampToTicks(stamp: number): number {
  const rollovers = stamp >>> 24;
  const down = stamp & 0x00ffffff;
  return (rollovers * 0x01000000 + (0x00ffffff - down)) >>> 0;
}

/**
 * Dead time between bursts, in nanoseconds. Stamps are [sync, end of burst 0,
 * end of burst 1, ...]; the time between consecutive burst ends minus the
 * burst's own duration is the gap where the analyzer was re-arming.
 */
export function burstGapsNs(stamps: readonly number[], sampleRate: number, postSamples: number, cpuHz: number): number[] {
  const tickNs = 1e9 / cpuHz;
  const burstNs = (postSamples * 1e9) / sampleRate;
  const gaps: number[] = [];
  for (let k = 2; k < stamps.length; k++) {
    const elapsed = (stampToTicks(stamps[k]) - stampToTicks(stamps[k - 1])) >>> 0;
    gaps.push(Math.max(0, elapsed * tickNs - burstNs));
  }
  return gaps;
}

export function channelLabel(channel: number): string {
  return channel === EXTERNAL_TRIGGER_CHANNEL ? 'EXT' : `CH${channel + 1}`;
}
