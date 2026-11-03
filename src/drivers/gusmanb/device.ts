/** Host driver for the gusmanb Pico logic analyzer over a SerialLink. */
import { createCapture } from '../../core/capture';
import { SerialLink, TimeoutError, delay } from '../serial/link';
import { formatHz, type CaptureDevice, type CaptureOutcome, type CaptureRunOptions, type DeviceSummary } from '../types';
import {
  CANCEL_BYTE,
  CMD_BLINK_OFF,
  CMD_BLINK_ON,
  CMD_DEVICE_INFO,
  CMD_START_CAPTURE,
  HandshakeError,
  buildFrame,
  burstGapsNs,
  bytesPerSample,
  channelLabel,
  decodeSamples,
  encodeCaptureRequest,
  parseDeviceInfo,
  requestFields,
  validateConfig,
  type GusmanbCaptureConfig,
  type GusmanbDeviceInfo,
} from './protocol';

/** The firmware waits up to ~2 s after USB enumeration before it answers. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CAPTURE_ACK_TIMEOUT_MS = 10_000;
/** The firmware checks for a cancel byte about every 2 s. */
const CANCEL_SETTLE_MS = 2_500;

/** The firmware refused the request, so it never armed. */
class DeviceRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceRejectedError';
  }
}

export class GusmanbDevice implements CaptureDevice<GusmanbCaptureConfig> {
  readonly info: GusmanbDeviceInfo;
  readonly summary: DeviceSummary;
  private readonly link: SerialLink;
  private busy = false;

  private constructor(link: SerialLink, info: GusmanbDeviceInfo) {
    this.link = link;
    this.info = info;
    this.summary = {
      kind: 'gusmanb',
      title: `gusmanb ${info.board} (V${info.major}_${info.minor}${info.turbo ? ', turbo' : ''})`,
      facts: [
        ['Firmware', info.versionLine],
        ['Channels', String(info.channelCount)],
        ['Max sample rate', formatHz(info.maxFrequency)],
        ['Blast rate', formatHz(info.blastFrequency)],
        ['Sample buffer', `${Math.round(info.bufferBytes / 1024)} KiB`],
      ],
    };
  }

  /** Performs the device-info handshake on an open link. */
  static async connect(link: SerialLink, signal?: AbortSignal): Promise<GusmanbDevice> {
    // Drop anything left over from a previous session (for example capture
    // data from a run the page never collected).
    await link.readUntilQuiet(150, 1500, signal);
    await link.write(buildFrame(CMD_DEVICE_INFO));
    const lines: string[] = [];
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    try {
      while (lines.length < 5) {
        const line = await link.readLine({ timeoutMs: Math.max(1, deadline - Date.now()), signal, maxLength: 256 });
        if (line.trim() === '') continue;
        // Skip noise until the banner appears.
        if (lines.length === 0 && !line.startsWith('LOGIC_ANALYZER_')) continue;
        lines.push(line);
      }
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw new HandshakeError(
          'No answer from the analyzer. Check that it runs gusmanb firmware V6 or newer, and that no other program has the port open.',
        );
      }
      throw err;
    }
    return new GusmanbDevice(link, parseDeviceInfo(lines));
  }

  async blink(on: boolean): Promise<void> {
    if (this.busy) return;
    await this.link.write(buildFrame(on ? CMD_BLINK_ON : CMD_BLINK_OFF));
    await this.link.readLine({ timeoutMs: 2000 }).catch(() => '');
  }

  async capture(config: GusmanbCaptureConfig, options: CaptureRunOptions = {}): Promise<CaptureOutcome> {
    const errors = validateConfig(config, this.info);
    if (errors.length > 0) throw new Error(errors.join(' '));
    if (this.busy) throw new Error('A capture is already running.');
    this.busy = true;
    const { signal, onProgress } = options;
    try {
      const fields = requestFields(config, this.info);
      onProgress?.({ phase: 'configuring' });
      this.link.discard();
      await this.link.write(buildFrame(CMD_START_CAPTURE, encodeCaptureRequest(fields)));
      try {
        return await this.receive(config, fields, signal, onProgress);
      } catch (err) {
        // Anything that goes wrong after the request is sent may leave the
        // analyzer armed or still streaming: cancel it and drop late data.
        // A rejection means the device never armed, so there is nothing to cancel.
        if (!(err instanceof DeviceRejectedError)) await this.cancelOnDevice();
        throw err;
      }
    } finally {
      this.busy = false;
    }
  }

  private async receive(
    config: GusmanbCaptureConfig,
    fields: ReturnType<typeof requestFields>,
    signal: AbortSignal | undefined,
    onProgress: CaptureRunOptions['onProgress'],
  ): Promise<CaptureOutcome> {
    await this.expectCaptureStarted(signal);
    onProgress?.({ phase: 'waiting-for-trigger' });
    const header = await this.link.readExact(4, { signal });
    const sampleCount = new DataView(header.buffer).getUint32(0, true);
    const expected = fields.preSamples + fields.postSamples * (fields.loopCount + 1);
    const plausibleMax = Math.floor(this.info.bufferBytes / bytesPerSample(fields.captureMode));
    if (sampleCount === 0 || sampleCount > plausibleMax) {
      throw new Error(`Device reported ${sampleCount} samples, which is not plausible. Reconnect and try again.`);
    }

    const bps = bytesPerSample(fields.captureMode);
    const raw = await this.link.readExact(sampleCount * bps, {
      signal,
      timeoutMs: 30_000,
      onProgress: (received, total) => onProgress?.({ phase: 'transferring', received, total }),
    });
    const stampCount = (await this.link.readExact(1, { timeoutMs: 5000, signal }))[0];
    const stamps: number[] = [];
    if (stampCount > 1) {
      const stampBytes = await this.link.readExact(stampCount * 4, { timeoutMs: 5000, signal });
      const view = new DataView(stampBytes.buffer);
      for (let i = 0; i < stampCount; i++) stamps.push(view.getUint32(i * 4, true));
    }

    onProgress?.({ phase: 'processing' });
    return this.buildOutcome(config, fields.loopCount, sampleCount, expected, raw, stamps);
  }

  async close(): Promise<void> {
    if (this.busy) {
      // Disconnecting mid-capture: cancel it so the analyzer is not left armed.
      try {
        await this.link.write(new Uint8Array([CANCEL_BYTE]));
      } catch {
        // Port already gone.
      }
    }
    await this.link.close();
  }

  private async expectCaptureStarted(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + CAPTURE_ACK_TIMEOUT_MS;
    for (;;) {
      const line = (await this.link.readLine({ timeoutMs: Math.max(1, deadline - Date.now()), signal })).trim();
      if (line === 'CAPTURE_STARTED') return;
      if (line === 'CAPTURE_ERROR') throw new DeviceRejectedError('The analyzer rejected the capture settings.');
      if (line.startsWith('ERR_')) throw new DeviceRejectedError(`The analyzer replied ${line}.`);
    }
  }

  /** Sends exactly one cancel byte, then discards whatever the device still sends. */
  private async cancelOnDevice(): Promise<void> {
    if (this.link.isClosed) return;
    try {
      await this.link.write(new Uint8Array([CANCEL_BYTE]));
      // The device notices within ~2 s and sends nothing back, but a capture
      // that finished at the same moment may still stream its data: discard it.
      await delay(CANCEL_SETTLE_MS);
      await this.link.readUntilQuiet(200, 3000);
    } catch {
      // The port may have gone away; nothing more to do.
    }
  }

  private buildOutcome(
    config: GusmanbCaptureConfig,
    loopCount: number,
    sampleCount: number,
    expected: number,
    raw: Uint8Array,
    stamps: readonly number[],
  ): CaptureOutcome {
    const warnings: string[] = [];
    const mode = requestFields(config, this.info).captureMode;
    if (sampleCount !== expected && config.trigger.type !== 'blast') {
      warnings.push(`Asked for ${expected} samples, received ${sampleCount}.`);
    }
    const samples = decodeSamples(raw, mode, sampleCount);
    const t = config.trigger;
    const triggerSample = t.type === 'blast' ? 0 : Math.min(config.preSamples, sampleCount);
    const burstStarts = Array.from({ length: loopCount }, (_, k) => config.preSamples + config.postSamples * (k + 1));
    const cpuHz = this.info.turbo ? 400_000_000 : 200_000_000;
    const gaps = stamps.length > 2 ? burstGapsNs(stamps, config.sampleRate, config.postSamples, cpuHz) : undefined;
    const capture = createCapture({
      sampleRate: config.sampleRate,
      channels: config.channels.map((ch, i) => ({ index: i, name: channelLabel(ch) })),
      samples,
      triggerSample,
      burstStarts: burstStarts.length > 0 ? burstStarts : undefined,
      burstGapsNs: gaps,
      source: this.summary.title,
    });
    return { capture, warnings };
  }
}
