/** Host driver for sigrok-pico over a SerialLink. */
import { allocWords, createCapture } from '../../core/capture';
import { AbortedError, SerialLink, TimeoutError, delay } from '../serial/link';
import { formatHz, type CaptureDevice, type CaptureOutcome, type CaptureRunOptions, type DeviceSummary } from '../types';
import {
  ANALOG_SCALE_PATTERN,
  DEFAULT_ANALOG_SCALE,
  IDENTIFY_PATTERN,
  PicoProtocolError,
  PicoStreamDecoder,
  analogChannelName,
  deviceSampleLimit,
  digitalChannelName,
  effectiveSampleRate,
  parseAnalogScale,
  parseIdentify,
  usesD4Mode,
  validatePicoConfig,
  type AnalogScale,
  type PicoCaptureConfig,
  type PicoIdentity,
} from './protocol';

const ACK_TIMEOUT_MS = 1000;
/** If no bytes arrive for this long mid-capture, assume the device stalled. */
const STREAM_STALL_MS = 15_000;

export class SigrokPicoDevice implements CaptureDevice<PicoCaptureConfig> {
  readonly identity: PicoIdentity;
  readonly analogScales: readonly AnalogScale[];
  readonly summary: DeviceSummary;
  private readonly link: SerialLink;
  private busy = false;

  private constructor(link: SerialLink, identity: PicoIdentity, scales: readonly AnalogScale[]) {
    this.link = link;
    this.identity = identity;
    this.analogScales = scales;
    this.summary = {
      kind: 'sigrok-pico',
      title: `sigrok-pico (${identity.digitalCount}D + ${identity.analogCount}A)`,
      facts: [
        ['Identify', identity.raw],
        ['Digital channels', String(identity.digitalCount)],
        ['Analog channels', String(identity.analogCount)],
        ['Max sample rate', formatHz(120_000_000)],
      ],
    };
  }

  static async connect(link: SerialLink, signal?: AbortSignal): Promise<SigrokPicoDevice> {
    const identity = await identify(link, signal);
    const scales: AnalogScale[] = [];
    for (let i = 0; i < identity.analogCount; i++) {
      await link.write(`a${i}\n`);
      try {
        const m = await link.readMatching(ANALOG_SCALE_PATTERN, { timeoutMs: 500, signal });
        scales.push(parseAnalogScale(m[0]));
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        scales.push(DEFAULT_ANALOG_SCALE);
      }
    }
    return new SigrokPicoDevice(link, identity, scales);
  }

  async capture(config: PicoCaptureConfig, options: CaptureRunOptions = {}): Promise<CaptureOutcome> {
    const errors = validatePicoConfig(config, this.identity);
    if (errors.length > 0) throw new Error(errors.join(' '));
    if (this.busy) throw new Error('A capture is already running.');
    this.busy = true;
    const { signal, onProgress } = options;
    try {
      onProgress?.({ phase: 'configuring' });
      const rate = effectiveSampleRate(config);
      await this.configure(config, rate, signal);

      const decoder = new PicoStreamDecoder({
        digitalChannels: config.digitalChannels,
        analogScales: [...config.analogChannels].sort((a, b) => a - b).map((a) => this.analogScales[a] ?? DEFAULT_ANALOG_SCALE),
        analogBytes: this.identity.analogBytes,
        limit: config.sampleCount,
        d4: usesD4Mode(config),
      });
      await this.link.write('F\n');
      await this.stream(decoder, config.sampleCount, signal, onProgress);
      onProgress?.({ phase: 'processing' });
      return this.buildOutcome(config, rate, decoder);
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    try {
      await this.link.write('+');
    } catch {
      // Port already gone.
    }
    await this.link.close();
  }

  private async configure(config: PicoCaptureConfig, rate: number, signal?: AbortSignal): Promise<void> {
    await this.link.write('\n*');
    await this.link.readUntilQuiet(50, 500, signal);
    const enabledAnalog = new Set(config.analogChannels);
    for (let i = 0; i < this.identity.analogCount; i++) {
      await this.command(`A${enabledAnalog.has(i) ? 1 : 0}${i}\n`, signal);
    }
    for (let i = 0; i < this.identity.digitalCount; i++) {
      await this.command(`D${i < config.digitalChannels ? 1 : 0}${i}\n`, signal);
    }
    await this.command(`L${deviceSampleLimit(config.sampleCount)}\n`, signal);
    await this.command(`R${rate}\n`, signal);
    await this.link.readUntilQuiet(20, 200, signal);
  }

  /** Sends a command and waits for the '*' acknowledgement. */
  private async command(text: string, signal?: AbortSignal): Promise<void> {
    this.link.discard();
    await this.link.write(text);
    try {
      await this.link.readMatching(/\*/, { timeoutMs: ACK_TIMEOUT_MS, signal });
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw new PicoProtocolError(`The device did not accept "${text.trim()}". Check the settings and reconnect.`);
      }
      throw err;
    }
  }

  private async stream(
    decoder: PicoStreamDecoder,
    wanted: number,
    signal: AbortSignal | undefined,
    onProgress: CaptureRunOptions['onProgress'],
  ): Promise<void> {
    let stopSent = false;
    let lastReport = 0;
    try {
      while (!decoder.finished) {
        await this.link.waitForData({ timeoutMs: STREAM_STALL_MS, signal });
        decoder.push(this.link.takeAvailable());
        if (decoder.sampleCount >= wanted && !stopSent && !decoder.finished) {
          // Continuous-style safety net: the device rounds the limit up.
          stopSent = true;
          await this.link.write('+');
        }
        const now = Date.now();
        if (now - lastReport > 100) {
          lastReport = now;
          onProgress?.({ phase: 'transferring', received: decoder.sampleCount, total: wanted });
        }
      }
    } catch (err) {
      if (err instanceof AbortedError) await this.stopOnDevice();
      if (err instanceof TimeoutError) {
        await this.stopOnDevice();
        throw new PicoProtocolError('The device stopped sending data. Try a lower sample rate or fewer channels.');
      }
      throw err;
    }
    await this.link.readUntilQuiet(50, 500);
  }

  private async stopOnDevice(): Promise<void> {
    try {
      await this.link.write('+');
      await delay(200);
      await this.link.readUntilQuiet(150, 2500);
    } catch {
      // Port gone; nothing more to do.
    }
  }

  private buildOutcome(config: PicoCaptureConfig, rate: number, decoder: PicoStreamDecoder): CaptureOutcome {
    const warnings: string[] = [];
    if (decoder.status === 'aborted') {
      if (decoder.sampleCount === 0) {
        throw new PicoProtocolError(
          'The device aborted the capture. USB could not keep up (try a lower rate or fewer channels), or the analog rate is too high.',
        );
      }
      warnings.push('The device aborted part-way; the samples received so far are shown.');
    }
    if (decoder.trailerByteCount !== undefined && decoder.trailerByteCount !== decoder.receivedDataBytes) {
      warnings.push(`Data loss: the device sent ${decoder.trailerByteCount} bytes but ${decoder.receivedDataBytes} arrived.`);
    }
    if (decoder.sampleCount < config.sampleCount) {
      warnings.push(`Asked for ${config.sampleCount} samples, received ${decoder.sampleCount}.`);
    }
    if (rate !== config.sampleRate) warnings.push(`The device sampled at ${formatHz(rate)} (nearest supported rate).`);
    const { digital, analog } = decoder.result();
    const analogIdx = [...config.analogChannels].sort((a, b) => a - b);
    const capture = createCapture({
      sampleRate: rate,
      channels: Array.from({ length: config.digitalChannels }, (_, i) => ({
        index: i,
        name: digitalChannelName(i, this.identity.digitalCount),
      })),
      // Analog-only captures still need a (zero-width) logic word per sample.
      samples: config.digitalChannels > 0 ? digital : allocWords(decoder.sampleCount, 1),
      analog: analog.map((data, k) => ({ name: analogChannelName(analogIdx[k]), unit: 'V', data })),
      source: this.summary.title,
    });
    return { capture, warnings };
  }
}

async function identify(link: SerialLink, signal?: AbortSignal): Promise<PicoIdentity> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // "\n" first flushes any half-typed command; "*" resets sampling state.
    await link.write('\n*');
    await delay(attempt === 0 ? 20 : 150, signal);
    await link.readUntilQuiet(100, 1500, signal);
    await link.write('i\n');
    try {
      const m = await link.readMatching(IDENTIFY_PATTERN, { timeoutMs: 1200, signal });
      return parseIdentify(m[0]);
    } catch (err) {
      if (!(err instanceof TimeoutError)) throw err;
    }
  }
  throw new PicoProtocolError('No answer from sigrok-pico. Check the firmware and that no other program has the port open.');
}
