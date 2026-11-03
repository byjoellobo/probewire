/**
 * Behavioural model of the gusmanb V6 firmware: framing, handshake, capture
 * replies and cancel-by-any-byte. Signals come from a caller-supplied source.
 */
import type { SampleWords } from '../../core/capture';
import {
  CMD_BLINK_OFF,
  CMD_BLINK_ON,
  CMD_DEVICE_INFO,
  CMD_START_CAPTURE,
  bytesPerSample,
  decodeCaptureRequest,
  parseFrame,
  type CaptureRequestFields,
} from '../gusmanb/protocol';
import type { FakeFirmware, FakePort } from './fakePort';

/** Simulated re-arm time between bursts: 2000 ticks at 200 MHz = 10 us. */
export const SIM_REARM_TICKS = 2000;

/** Produces pin-level samples: bit n of each word is the level of channel n (0-23). */
export type PinSignalSource = (sampleRate: number, sampleCount: number) => SampleWords;

export interface GusmanbFirmwareOptions {
  board?: string;
  version?: string;
  maxFrequency?: number;
  blastFrequency?: number;
  bufferBytes?: number;
  channelCount?: number;
  /** Delay before captured data is sent, emulating the wait for a trigger. */
  triggerDelayMs?: number;
  chunkSize?: number;
  /** Fault injection: answer every capture request with CAPTURE_ERROR. */
  rejectCaptures?: boolean;
  source: PinSignalSource;
}

export class GusmanbFirmware implements FakeFirmware {
  readonly opts: Required<GusmanbFirmwareOptions>;
  lastRequest: CaptureRequestFields | undefined;
  blinking = false;
  private rx: number[] = [];
  private capturing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: GusmanbFirmwareOptions) {
    this.opts = {
      board: 'PICO_2',
      version: 'V6_0',
      maxFrequency: 100_000_000,
      blastFrequency: 200_000_000,
      bufferBytes: 393_216,
      channelCount: 24,
      triggerDelayMs: 5,
      chunkSize: 512,
      rejectCaptures: false,
      ...options,
    };
  }

  /** True while a capture is armed (waiting for its trigger). */
  get isCapturing(): boolean {
    return this.capturing;
  }

  receive(bytes: Uint8Array, port: FakePort): void {
    if (this.capturing) {
      // Any byte cancels a running capture; the firmware answers nothing.
      this.capturing = false;
      if (this.timer !== undefined) clearTimeout(this.timer);
      return;
    }
    for (const b of bytes) this.feed(b, port);
  }

  detach(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.capturing = false;
    this.rx = [];
  }

  private feed(b: number, port: FakePort): void {
    this.rx.push(b);
    if (this.rx.length === 1 && b !== 0x55) this.rx = [];
    else if (this.rx.length === 2 && b !== 0xaa) this.rx = b === 0x55 ? [0x55] : [];
    if (this.rx.length >= 5 && this.rx[this.rx.length - 2] === 0xaa && this.rx[this.rx.length - 1] === 0x55) {
      const payload = parseFrame(new Uint8Array(this.rx));
      this.rx = [];
      if (payload) this.handle(payload, port);
    }
    if (this.rx.length > 128) this.rx = [];
  }

  private handle(payload: Uint8Array, port: FakePort): void {
    const o = this.opts;
    switch (payload[0]) {
      case CMD_DEVICE_INFO:
        port.send(
          `LOGIC_ANALYZER_${o.board}_${o.version}\r\nFREQ:${o.maxFrequency}\r\nBLASTFREQ:${o.blastFrequency}\r\n` +
            `BUFFER:${o.bufferBytes}\r\nCHANNELS:${o.channelCount}\r\n`,
        );
        return;
      case CMD_START_CAPTURE:
        this.startCapture(decodeCaptureRequest(payload.subarray(1)), port);
        return;
      case CMD_BLINK_ON:
      case CMD_BLINK_OFF:
        this.blinking = payload[0] === CMD_BLINK_ON;
        port.send(this.blinking ? 'BLINKON\r\n' : 'BLINKOFF\r\n');
        return;
      default:
        port.send('ERR_UNKNOWN_MSG\r\n');
    }
  }

  private startCapture(req: CaptureRequestFields, port: FakePort): void {
    this.lastRequest = req;
    const bps = bytesPerSample(req.captureMode);
    const blast = req.triggerType === 3;
    const count = blast ? req.postSamples : req.preSamples + req.postSamples * (req.loopCount + 1);
    const maxRate = blast ? this.opts.blastFrequency : this.opts.maxFrequency;
    if (this.opts.rejectCaptures || count * bps > this.opts.bufferBytes || req.frequency > maxRate || req.channels.length < 1 || req.channels.length > 24) {
      port.send('CAPTURE_ERROR\r\n');
      return;
    }
    port.send('CAPTURE_STARTED\r\n');
    this.capturing = true;
    this.timer = setTimeout(() => {
      if (!this.capturing) return;
      this.capturing = false;
      port.send(this.captureReply(req, count, bps), this.opts.chunkSize);
    }, this.opts.triggerDelayMs);
  }

  private captureReply(req: CaptureRequestFields, count: number, bps: number): Uint8Array {
    const pins = this.opts.source(req.frequency, count);
    const measuring = req.loopCount > 0 && req.measure;
    const stampCount = measuring ? req.loopCount + 2 : 0;
    const out = new Uint8Array(4 + count * bps + 1 + (stampCount > 1 ? stampCount * 4 : 0));
    const v = new DataView(out.buffer);
    v.setUint32(0, count, true);
    for (let i = 0; i < count; i++) {
      // Remap: bit k of the sent word is the pin listed at position k.
      let word = 0;
      req.channels.forEach((pin, k) => {
        word |= ((pins[i] >>> pin) & 1) << k;
      });
      word >>>= 0;
      const at = 4 + i * bps;
      if (bps === 1) v.setUint8(at, word);
      else if (bps === 2) v.setUint16(at, word, true);
      else v.setUint32(at, word, true);
    }
    const stampAt = 4 + count * bps;
    v.setUint8(stampAt, stampCount);
    if (stampCount > 1) {
      // Stamps: [sync, end of burst 0, end of burst 1, ...]. SysTick runs at
      // 200 MHz; model SIM_REARM_TICKS of re-arm time before each extra burst.
      const burstTicks = Math.round((req.postSamples / req.frequency) * 200e6);
      let elapsed = 1000;
      for (let k = 0; k < stampCount; k++) {
        if (k === 1) elapsed += burstTicks;
        else if (k >= 2) elapsed += burstTicks + SIM_REARM_TICKS;
        const rollovers = Math.floor(elapsed / 0x1000000) & 0xff;
        const down = 0xffffff - (elapsed % 0x1000000);
        v.setUint32(stampAt + 1 + k * 4, ((rollovers << 24) | down) >>> 0, true);
      }
    }
    return out;
  }
}
