/**
 * Serial protocol of sigrok-pico (pico-coder/sigrok-pico), the Raspberry Pi
 * Pico firmware that implements libsigrok's "raspberrypi-pico" device.
 *
 * Commands are ASCII lines; most acknowledge with a single '*'. Captures
 * stream continuously. Byte classes in the stream:
 *   >= 0x80     data (7 payload bits each)
 *   0x30..0x7F  run-length counts (repeat the previous sample)
 *   <  0x30     control: '$' starts the "$<bytecount>+" trailer, anything else
 *               (e.g. '!') means the device aborted
 *
 * Implemented from a description of the protocol; no code from the GPL-3.0
 * firmware or libsigrok driver is included.
 */
import { allocWords, wordBytesFor, type SampleWords } from '../../core/capture';

export const SIGROK_PICO_USB_FILTER = { usbVendorId: 0x2e8a } as const;

export const MIN_SAMPLE_RATE = 5_000;
export const MAX_SAMPLE_RATE = 120_000_000;
/** The ADC aborts unless 48 MHz / (rate x analog channels) > 96. */
export const MAX_ANALOG_AGGREGATE_RATE = 494_845;
const ADC_COMBINED_CLOCK = 24_000_000;

export interface PicoIdentity {
  readonly raw: string;
  readonly analogCount: number;
  readonly analogBytes: number;
  readonly digitalCount: number;
  readonly version: number;
}

export class PicoProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PicoProtocolError';
  }
}

export const IDENTIFY_PATTERN = /SRPICO,A(\d\d)(\d)D(\d\d),(\d\d)/;

export function parseIdentify(text: string): PicoIdentity {
  const m = IDENTIFY_PATTERN.exec(text);
  if (!m) throw new PicoProtocolError(`Not a sigrok-pico identify reply: "${text.slice(0, 40)}"`);
  const version = Number(m[4]);
  if (version !== 2) throw new PicoProtocolError(`Unsupported sigrok-pico protocol version ${m[4]} (expected 02)`);
  const analogBytes = Number(m[2]);
  if (analogBytes < 1 || analogBytes > 4) throw new PicoProtocolError(`Unexpected analog sample size ${analogBytes}`);
  return {
    raw: m[0],
    analogCount: Number(m[1]),
    analogBytes,
    digitalCount: Number(m[3]),
    version,
  };
}

export interface AnalogScale {
  /** Volts per LSB. */
  readonly scale: number;
  /** Volts added after scaling. */
  readonly offset: number;
}

/** Reply to "a<n>": "<microvolts per LSB>x<offset microvolts>", e.g. "25700x0". */
export const ANALOG_SCALE_PATTERN = /(\d+)x(-?\d+)/;
export const DEFAULT_ANALOG_SCALE: AnalogScale = { scale: 25_700 / 1e6, offset: 0 };

export function parseAnalogScale(text: string): AnalogScale {
  const m = ANALOG_SCALE_PATTERN.exec(text);
  if (!m) return DEFAULT_ANALOG_SCALE;
  return { scale: Number(m[1]) / 1e6, offset: Number(m[2]) / 1e6 };
}

/** GPIO label for digital channel `index`, based on the firmware build (21, 26 or 32 channels). */
export function digitalChannelName(index: number, digitalCount: number): string {
  if (digitalCount >= 32) return `GP${index}`;
  if (digitalCount === 26) return `GP${index < 23 ? index : index + 3}`;
  return `GP${index + 2}`;
}

export function analogChannelName(index: number): string {
  return `ADC${index}`;
}

export interface PicoCaptureConfig {
  /** Number of digital channels, always contiguous from channel 0. */
  readonly digitalChannels: number;
  /** Analog channel indices to enable. */
  readonly analogChannels: readonly number[];
  readonly sampleRate: number;
  readonly sampleCount: number;
}

/**
 * Applies the device's rate rules and returns the rate that will actually be
 * used. With both analog and digital channels the rate must divide 24 MHz.
 */
export function effectiveSampleRate(config: PicoCaptureConfig): number {
  let rate = Math.max(MIN_SAMPLE_RATE, Math.floor(config.sampleRate));
  rate = Math.min(rate, MAX_SAMPLE_RATE);
  if (config.analogChannels.length > 0 && config.digitalChannels > 0 && ADC_COMBINED_CLOCK % rate !== 0) {
    rate = Math.floor(ADC_COMBINED_CLOCK / (Math.floor(ADC_COMBINED_CLOCK / rate) + 1));
  }
  return rate - (rate % 2);
}

export function validatePicoConfig(config: PicoCaptureConfig, id: PicoIdentity): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(config.digitalChannels) || config.digitalChannels < 0 || config.digitalChannels > id.digitalCount) {
    errors.push(`Digital channels must be 0 to ${id.digitalCount}.`);
  }
  if (config.analogChannels.some((a) => !Number.isInteger(a) || a < 0 || a >= id.analogCount)) {
    errors.push(id.analogCount === 0 ? 'This firmware build has no analog channels.' : `Analog channels must be 0 to ${id.analogCount - 1}.`);
  }
  if (config.digitalChannels === 0 && config.analogChannels.length === 0) errors.push('Enable at least one channel.');
  if (!Number.isFinite(config.sampleRate) || config.sampleRate < MIN_SAMPLE_RATE || config.sampleRate > MAX_SAMPLE_RATE) {
    errors.push(`Sample rate must be ${MIN_SAMPLE_RATE} Hz to ${MAX_SAMPLE_RATE / 1e6} MHz.`);
  }
  const rate = effectiveSampleRate(config);
  if (config.analogChannels.length > 0 && rate * config.analogChannels.length > MAX_ANALOG_AGGREGATE_RATE) {
    const max = Math.floor(MAX_ANALOG_AGGREGATE_RATE / config.analogChannels.length);
    errors.push(`With ${config.analogChannels.length} analog channel(s) the sample rate can be at most ${max} Hz.`);
  }
  if (!Number.isInteger(config.sampleCount) || config.sampleCount < 16 || config.sampleCount > 200_000_000) {
    errors.push('Sample count must be 16 to 200,000,000.');
  }
  return errors;
}

/** Sample limit sent to the device: at least 16 and a multiple of 8 (the D4 encoder works in groups of 8). */
export function deviceSampleLimit(sampleCount: number): number {
  return Math.max(16, Math.ceil(sampleCount / 8) * 8);
}

/** D4 mode packs a 4-bit sample and a 3-bit repeat into one byte; used for <= 4 digital channels and no analog. */
export function usesD4Mode(config: PicoCaptureConfig): boolean {
  return config.analogChannels.length === 0 && config.digitalChannels > 0 && config.digitalChannels <= 4;
}

// ---------------------------------------------------------------------------
// Stream decoding
// ---------------------------------------------------------------------------

export interface StreamDecoderOptions {
  readonly digitalChannels: number;
  readonly analogScales: readonly AnalogScale[];
  readonly analogBytes: number;
  /** Samples wanted; extra samples from the device are dropped. */
  readonly limit: number;
  readonly d4: boolean;
}

export type StreamState = 'streaming' | 'trailer' | 'done' | 'aborted';

/** Incremental decoder. Feed it chunks in arrival order with push(). */
export class PicoStreamDecoder {
  private readonly opts: StreamDecoderOptions;
  private readonly digital: SampleWords;
  private readonly analog: Float32Array[];
  private readonly mask: number;
  private readonly digitalGroups: number;
  private readonly sliceBytes: number;
  private readonly slice: Uint8Array;
  private slicePos = 0;
  private lastWord = 0;
  private readonly lastAnalog: Float32Array;
  private count = 0;
  private state: StreamState = 'streaming';
  private trailerText = '';
  private dataBytes = 0;
  private reportedBytes: number | undefined;

  constructor(opts: StreamDecoderOptions) {
    this.opts = opts;
    const nA = opts.analogScales.length;
    this.digital = allocWords(opts.digitalChannels > 0 ? opts.limit : 0, wordBytesFor(Math.max(1, opts.digitalChannels)));
    this.analog = opts.analogScales.map(() => new Float32Array(opts.limit));
    this.lastAnalog = new Float32Array(nA);
    this.mask = opts.digitalChannels >= 32 ? 0xffffffff : 2 ** opts.digitalChannels - 1;
    this.digitalGroups = Math.ceil(opts.digitalChannels / 7);
    this.sliceBytes = this.digitalGroups + nA * opts.analogBytes;
    this.slice = new Uint8Array(Math.max(1, this.sliceBytes));
  }

  get sampleCount(): number {
    return Math.min(this.count, this.opts.limit);
  }

  get status(): StreamState {
    return this.state;
  }

  get finished(): boolean {
    return this.state === 'done' || this.state === 'aborted';
  }

  /** Data and run-length bytes received, for comparison with the trailer's count. */
  get receivedDataBytes(): number {
    return this.dataBytes;
  }

  /** Byte count reported in the "$<n>+" trailer, once seen. */
  get trailerByteCount(): number | undefined {
    return this.reportedBytes;
  }

  push(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length && !this.finished; i++) {
      const b = chunk[i];
      if (this.state === 'trailer') this.trailerByte(b);
      else if (this.opts.d4) this.d4Byte(b);
      else this.generalByte(b);
    }
  }

  result(): { digital: SampleWords; analog: Float32Array[] } {
    const n = this.sampleCount;
    // Copy only when the buffers were not filled; a full buffer is returned as is.
    const fit = <T extends SampleWords | Float32Array>(a: T): T => (a.length === n ? a : (a.slice(0, n) as T));
    return {
      digital: this.digital.length > 0 ? fit(this.digital) : this.digital,
      analog: this.analog.map(fit),
    };
  }

  private control(b: number): void {
    if (b === 0x24) {
      this.state = 'trailer';
      this.trailerText = '';
    } else {
      this.state = 'aborted';
    }
  }

  private trailerByte(b: number): void {
    if (b === 0x2b) {
      this.reportedBytes = this.trailerText === '' ? undefined : Number.parseInt(this.trailerText, 10);
      this.state = 'done';
    } else if (b >= 0x30 && b <= 0x39) {
      this.trailerText += String.fromCharCode(b);
    } else {
      this.state = 'aborted';
    }
  }

  private d4Byte(b: number): void {
    if (b >= 0x80) {
      this.emit((b >> 4) & 7);
      this.lastWord = b & 0x0f & this.mask;
      this.emit(1);
      this.dataBytes++;
    } else if (b >= 0x30) {
      this.emit((b - 47) * 8);
      this.dataBytes++;
    } else {
      this.control(b);
    }
  }

  private generalByte(b: number): void {
    if (this.slicePos === 0) {
      if (b < 0x30) {
        this.control(b);
        return;
      }
      if (b < 0x80) {
        this.emit(b <= 79 ? b - 47 : (b - 78) * 32);
        this.dataBytes++;
        return;
      }
    } else if (b < 0x80) {
      // A non-data byte inside a slice means the stream is out of step.
      if (b < 0x30) this.control(b);
      else this.state = 'aborted';
      return;
    }
    this.slice[this.slicePos++] = b;
    if (this.slicePos === this.sliceBytes) {
      this.slicePos = 0;
      this.dataBytes += this.sliceBytes;
      this.decodeSlice();
      this.emit(1);
    }
  }

  private decodeSlice(): void {
    let word = 0;
    for (let g = 0; g < this.digitalGroups; g++) word += (this.slice[g] & 0x7f) * 2 ** (7 * g);
    this.lastWord = (word & this.mask) >>> 0;
    const aBytes = this.opts.analogBytes;
    this.opts.analogScales.forEach((s, c) => {
      let raw = 0;
      const base = this.digitalGroups + c * aBytes;
      for (let k = 0; k < aBytes; k++) raw += (this.slice[base + k] - 0x80) * 2 ** (7 * k);
      this.lastAnalog[c] = raw * s.scale + s.offset;
    });
  }

  private emit(repeat: number): void {
    if (repeat <= 0) return;
    const start = this.count;
    const end = Math.min(start + repeat, this.opts.limit);
    if (end > start) {
      if (this.digital.length > 0) this.digital.fill(this.lastWord, start, end);
      for (let c = 0; c < this.analog.length; c++) this.analog[c].fill(this.lastAnalog[c], start, end);
    }
    this.count += repeat;
  }
}
