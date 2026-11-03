/**
 * Behavioural model of the sigrok-pico firmware: line commands, '*' acks and
 * the streamed sample encoding (D4 and general mode, run-length bytes and the
 * "$<bytecount>+" trailer). The encoder is written from the protocol
 * description, independently of the host-side decoder.
 */
import type { FakeFirmware, FakePort } from './fakePort';

export interface PicoSignal {
  /** Bit i = digital channel i. */
  readonly digital: ArrayLike<number>;
  /** Raw 7-bit ADC codes (0-127) per enabled analog channel, ascending channel order. */
  readonly analog: ReadonlyArray<ArrayLike<number>>;
}

export interface PicoFirmwareOptions {
  analogCount?: number;
  digitalCount?: number;
  chunkSize?: number;
  /** Abort with "!!!" after this many stream bytes (simulates a USB overrun). */
  abortAfterBytes?: number;
  /** Silently drop this many bytes from the middle of the stream (simulates data loss). */
  dropBytes?: number;
  source: (config: { digitalChannels: number; analogChannels: number[]; rate: number; count: number }) => PicoSignal;
}

export class PicoFirmware implements FakeFirmware {
  readonly opts: Required<PicoFirmwareOptions>;
  readonly commands: string[] = [];
  private line = '';
  private analogEnabled = new Set<number>();
  private digitalEnabled = new Set<number>();
  private limit = 0;
  private rate = 0;
  private streaming = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PicoFirmwareOptions) {
    this.opts = { analogCount: 3, digitalCount: 21, chunkSize: 64, abortAfterBytes: 0, dropBytes: 0, ...options };
  }

  receive(bytes: Uint8Array, port: FakePort): void {
    for (const b of bytes) {
      const c = String.fromCharCode(b);
      if (c === '*') {
        this.line = '';
        continue;
      }
      if (c === '+') {
        this.stop(port);
        continue;
      }
      if (c === '\n' || c === '\r') {
        if (this.line.length > 0) this.command(this.line, port);
        this.line = '';
      } else {
        this.line += c;
        if (this.line.length >= 19) this.line = '';
      }
    }
  }

  detach(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.streaming = false;
  }

  private command(cmd: string, port: FakePort): void {
    this.commands.push(cmd);
    const o = this.opts;
    const head = cmd[0];
    const arg = cmd.slice(1);
    if (cmd === 'i') {
      port.send(`SRPICO,A${String(o.analogCount).padStart(2, '0')}1D${String(o.digitalCount).padStart(2, '0')},02`);
    } else if (head === 'a') {
      port.send('25700x0');
    } else if ((head === 'A' || head === 'D') && /^[01]\d+$/.test(arg)) {
      const set = head === 'A' ? this.analogEnabled : this.digitalEnabled;
      const ch = Number(arg.slice(1));
      if (arg[0] === '1') set.add(ch);
      else set.delete(ch);
      port.send('*');
    } else if (head === 'L' && Number(arg) > 0) {
      this.limit = Math.max(16, (Number(arg) + 3) & ~3);
      port.send('*');
    } else if (head === 'R' && Number(arg) >= 5000 && Number(arg) <= 120_000_016) {
      this.rate = Number(arg);
      port.send('*');
    } else if (cmd === 'F' || cmd === 'C') {
      this.start(port);
    }
    // Unknown or invalid commands get no reply, as on the real device.
  }

  private start(port: FakePort): void {
    const analogChannels = [...this.analogEnabled].sort((a, b) => a - b);
    const digitalChannels = this.digitalEnabled.size;
    const signal = this.opts.source({ digitalChannels, analogChannels, rate: this.rate, count: this.limit });
    let stream = encodeStream(signal, digitalChannels, analogChannels.length, this.limit);
    const dataBytes = stream.length;
    if (this.opts.dropBytes > 0) {
      const at = Math.floor(stream.length / 2);
      stream = new Uint8Array([...stream.subarray(0, at), ...stream.subarray(at + this.opts.dropBytes)]);
    }
    this.streaming = true;
    if (this.opts.abortAfterBytes > 0) {
      port.send(stream.subarray(0, this.opts.abortAfterBytes), this.opts.chunkSize);
      this.timer = setTimeout(() => {
        port.send('!!!$0+');
        this.streaming = false;
      }, 5);
      return;
    }
    this.timer = setTimeout(() => {
      port.send(stream, this.opts.chunkSize);
      port.send(`$${dataBytes}+\n`, this.opts.chunkSize);
      this.streaming = false;
    }, 2);
  }

  private stop(port: FakePort): void {
    if (!this.streaming) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.streaming = false;
    port.send('$0+\n');
  }
}

/** Encodes samples the way the firmware streams them. */
export function encodeStream(signal: PicoSignal, digitalChannels: number, analogCount: number, count: number): Uint8Array {
  if (analogCount === 0 && digitalChannels > 0 && digitalChannels <= 4) return encodeD4(signal.digital, count);
  return encodeGeneral(signal, digitalChannels, analogCount, count);
}

function encodeD4(digital: ArrayLike<number>, count: number): Uint8Array {
  const out: number[] = [];
  let prev = -1;
  let pending = 0;
  const flushLong = (): void => {
    while (pending >= 8) {
      const k = Math.min(80, Math.floor(pending / 8));
      out.push(47 + k);
      pending -= k * 8;
    }
  };
  for (let i = 0; i < count; i++) {
    const v = digital[i] & 0x0f;
    if (v === prev) {
      pending++;
      continue;
    }
    flushLong();
    out.push(0x80 | (pending << 4) | v);
    pending = 0;
    prev = v;
  }
  flushLong();
  if (pending > 0) out.push(0x80 | ((pending - 1) << 4) | prev);
  return new Uint8Array(out);
}

function encodeGeneral(signal: PicoSignal, digitalChannels: number, analogCount: number, count: number): Uint8Array {
  const groups = Math.ceil(digitalChannels / 7);
  const out: number[] = [];
  let prevKey = '';
  let repeats = 0;
  const flush = (): void => {
    let c = repeats;
    while (c >= 1568) {
      out.push(127);
      c -= 1568;
    }
    if (c > 32) {
      const d = c >> 5;
      out.push(d + 78);
      c -= d << 5;
    }
    if (c > 0) out.push(47 + c);
    repeats = 0;
  };
  for (let i = 0; i < count; i++) {
    const slice: number[] = [];
    const word = digitalChannels > 0 ? signal.digital[i] : 0;
    for (let g = 0; g < groups; g++) slice.push(0x80 | (Math.floor(word / 2 ** (7 * g)) & 0x7f));
    for (let a = 0; a < analogCount; a++) slice.push(0x80 | (signal.analog[a][i] & 0x7f));
    const key = slice.join(',');
    if (analogCount === 0 && key === prevKey) {
      repeats++;
      continue;
    }
    flush();
    out.push(...slice);
    prevKey = key;
  }
  flush();
  return new Uint8Array(out);
}
