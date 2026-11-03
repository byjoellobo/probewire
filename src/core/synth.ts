/**
 * Deterministic logic signal generator.
 *
 * Used by the decoder tests and by the in-app demo device. Each channel keeps a
 * list of level changes (sample index + new level); build() renders them into
 * packed sample words. Times are in seconds and are converted to sample
 * indices with Math.round(time * sampleRate).
 */
import { allocWords, wordBytesFor, MAX_LOGIC_CHANNELS, type SampleWords } from './capture';

export interface UartSynthOptions {
  baud: number;
  /** 5 to 9, default 8. */
  dataBits?: number;
  parity?: 'none' | 'odd' | 'even' | 'zero' | 'one';
  stopBits?: 1 | 1.5 | 2;
  bitOrder?: 'lsb' | 'msb';
  invert?: boolean;
  /** Idle bits between frames, default 0. */
  gapBits?: number;
}

export interface I2cSynthTransaction {
  /** 7-bit address, or a 10-bit address when greater than 0x7F. */
  address: number;
  read: boolean;
  data: readonly number[];
  /** The slave does not acknowledge its address; no data follows. */
  nackAddress?: boolean;
}

export interface SpiSynthOptions {
  freq: number;
  mode?: 0 | 1 | 2 | 3;
  bitOrder?: 'msb' | 'lsb';
  /** Bits per word, default 8. */
  wordSize?: number;
  csActiveHigh?: boolean;
}

export interface SpiPins {
  cs?: number;
  clk: number;
  mosi?: number;
  miso?: number;
}

type Level = 0 | 1;

interface ChannelEvents {
  readonly samples: number[];
  readonly levels: Level[];
  sorted: boolean;
}

export class SignalBuilder {
  private readonly sampleRate: number;
  private readonly sampleCount: number;
  private readonly channelCount: number;
  private readonly idleLevels: Level[];
  private readonly explicitIdle: boolean[];
  private readonly events: ChannelEvents[];

  constructor(sampleRate: number, sampleCount: number, channelCount: number) {
    if (!(sampleRate > 0)) throw new RangeError(`Sample rate must be positive (got ${sampleRate})`);
    if (!Number.isInteger(sampleCount) || sampleCount < 0) {
      throw new RangeError(`Sample count must be a non-negative integer (got ${sampleCount})`);
    }
    if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > MAX_LOGIC_CHANNELS) {
      throw new RangeError(`Channel count must be 1..${MAX_LOGIC_CHANNELS} (got ${channelCount})`);
    }
    this.sampleRate = sampleRate;
    this.sampleCount = sampleCount;
    this.channelCount = channelCount;
    this.idleLevels = new Array<Level>(channelCount).fill(0);
    this.explicitIdle = new Array<boolean>(channelCount).fill(false);
    this.events = Array.from({ length: channelCount }, () => ({ samples: [], levels: [], sorted: true }));
  }

  /** Sets a channel's level from time 0 until its first event. */
  idle(ch: number, level: Level): this {
    this.checkChannel(ch);
    this.idleLevels[ch] = level;
    this.explicitIdle[ch] = true;
    return this;
  }

  /** Adds a raw level change. */
  level(ch: number, time: number, level: Level): this {
    this.checkChannel(ch);
    this.push(ch, time, level);
    return this;
  }

  uart(ch: number, startTime: number, bytes: readonly number[], opts: UartSynthOptions): number {
    this.checkChannel(ch);
    if (!(opts.baud > 0)) throw new RangeError(`Baud rate must be positive (got ${opts.baud})`);
    const dataBits = opts.dataBits ?? 8;
    if (!Number.isInteger(dataBits) || dataBits < 5 || dataBits > 9) {
      throw new RangeError(`UART data bits must be 5..9 (got ${dataBits})`);
    }
    const parity = opts.parity ?? 'none';
    const stopBits = opts.stopBits ?? 1;
    const msb = opts.bitOrder === 'msb';
    const invert = opts.invert ?? false;
    const bitT = 1 / opts.baud;
    const gapT = (opts.gapBits ?? 0) * bitT;
    const line = (v: Level): Level => (invert ? ((1 - v) as Level) : v);
    this.autoIdle(ch, line(1));

    let t = startTime;
    for (const byte of bytes) {
      const value = byte & ((1 << dataBits) - 1);
      this.push(ch, t, line(0));
      t += bitT;
      let ones = 0;
      for (let b = 0; b < dataBits; b++) {
        const v = ((value >> (msb ? dataBits - 1 - b : b)) & 1) as Level;
        ones += v;
        this.push(ch, t, line(v));
        t += bitT;
      }
      if (parity !== 'none') {
        this.push(ch, t, line(parityBit(parity, ones)));
        t += bitT;
      }
      this.push(ch, t, line(1));
      t += bitT * stopBits + gapT;
    }
    return t;
  }

  i2c(scl: number, sda: number, startTime: number, transactions: readonly I2cSynthTransaction[], freq: number): number {
    this.checkChannel(scl);
    this.checkChannel(sda);
    if (!(freq > 0)) throw new RangeError(`I2C clock must be positive (got ${freq})`);
    this.autoIdle(scl, 1);
    this.autoIdle(sda, 1);
    const q = 1 / freq / 4;
    let t = startTime;
    // START: SDA falls while SCL is high, then SCL goes low.
    this.push(sda, t, 0);
    t += 2 * q;
    this.push(scl, t, 0);
    transactions.forEach((tr, k) => {
      if (k > 0) t = this.i2cRepeatedStart(scl, sda, t, q);
      t = this.i2cTransaction(scl, sda, t, tr, q);
    });
    // STOP: SDA rises while SCL is high.
    this.push(sda, t + q, 0);
    this.push(scl, t + 2 * q, 1);
    this.push(sda, t + 3 * q, 1);
    return t + 4 * q;
  }

  spi(pins: SpiPins, startTime: number, mosi: readonly number[], miso: readonly number[], opts: SpiSynthOptions): number {
    this.checkChannel(pins.clk);
    for (const pin of [pins.cs, pins.mosi, pins.miso]) if (pin !== undefined) this.checkChannel(pin);
    if (!(opts.freq > 0)) throw new RangeError(`SPI clock must be positive (got ${opts.freq})`);
    const mode = opts.mode ?? 0;
    const cpol = (mode >> 1) as Level;
    const cpha = mode & 1;
    const wordSize = opts.wordSize ?? 8;
    if (!Number.isInteger(wordSize) || wordSize < 1 || wordSize > 32) {
      throw new RangeError(`SPI word size must be 1..32 (got ${wordSize})`);
    }
    const msb = opts.bitOrder !== 'lsb';
    const csActive: Level = opts.csActiveHigh ? 1 : 0;
    const period = 1 / opts.freq;
    const half = period / 2;
    this.autoIdle(pins.clk, cpol);
    if (pins.cs !== undefined) this.autoIdle(pins.cs, (1 - csActive) as Level);

    let t = startTime;
    if (pins.cs !== undefined) {
      this.push(pins.cs, t, csActive);
      t += half;
    }
    const words = Math.max(mosi.length, miso.length);
    for (let w = 0; w < words; w++) {
      for (let b = 0; b < wordSize; b++) {
        const idx = msb ? wordSize - 1 - b : b;
        const setData = (at: number): void => {
          if (pins.mosi !== undefined) this.push(pins.mosi, at, bitOf(mosi[w] ?? 0, idx));
          if (pins.miso !== undefined) this.push(pins.miso, at, bitOf(miso[w] ?? 0, idx));
        };
        if (cpha === 0) {
          setData(t);
          this.push(pins.clk, t + half, (1 - cpol) as Level);
          this.push(pins.clk, t + period, cpol);
        } else {
          this.push(pins.clk, t, (1 - cpol) as Level);
          setData(t);
          this.push(pins.clk, t + half, cpol);
        }
        t += period;
      }
    }
    if (pins.cs !== undefined) {
      t += half;
      this.push(pins.cs, t, (1 - csActive) as Level);
    }
    return t;
  }

  clock(ch: number, startTime: number, endTime: number, freq: number, duty = 0.5): number {
    this.checkChannel(ch);
    if (!(freq > 0)) throw new RangeError(`Clock frequency must be positive (got ${freq})`);
    if (!(duty > 0 && duty < 1)) throw new RangeError(`Duty cycle must be between 0 and 1 (got ${duty})`);
    const period = 1 / freq;
    for (let k = 0; ; k++) {
      const t = startTime + k * period;
      if (t >= endTime) break;
      this.push(ch, t, 1);
      this.push(ch, Math.min(t + duty * period, endTime), 0);
    }
    return endTime;
  }

  build(): SampleWords {
    const n = this.sampleCount;
    const words = allocWords(n, wordBytesFor(this.channelCount));
    for (let ch = 0; ch < this.channelCount; ch++) this.renderChannel(words, ch);
    return words;
  }

  private renderChannel(words: SampleWords, ch: number): void {
    const n = this.sampleCount;
    const mask = 1 << ch;
    const ev = this.events[ch];
    const order = ev.sorted ? undefined : sortedOrder(ev.samples);
    let level = this.idleLevels[ch];
    let pos = 0;
    const count = ev.samples.length;
    for (let k = 0; k < count; k++) {
      const e = order ? order[k] : k;
      const s = Math.min(Math.max(ev.samples[e], 0), n);
      if (s > pos) {
        if (level === 1) for (let i = pos; i < s; i++) words[i] |= mask;
        pos = s;
      }
      level = ev.levels[e];
    }
    if (level === 1) for (let i = pos; i < n; i++) words[i] |= mask;
  }

  private i2cByte(scl: number, sda: number, start: number, byte: number, ack: Level, q: number): number {
    let t = start;
    for (let b = 0; b < 9; b++) {
      const v = b < 8 ? (((byte >> (7 - b)) & 1) as Level) : ack;
      this.push(sda, t + q, v);
      this.push(scl, t + 2 * q, 1);
      this.push(scl, t + 4 * q, 0);
      t += 4 * q;
    }
    return t;
  }

  private i2cRepeatedStart(scl: number, sda: number, start: number, q: number): number {
    this.push(sda, start + q, 1);
    this.push(scl, start + 2 * q, 1);
    this.push(sda, start + 3 * q, 0);
    this.push(scl, start + 4 * q, 0);
    return start + 4 * q;
  }

  private i2cTransaction(scl: number, sda: number, start: number, tr: I2cSynthTransaction, q: number): number {
    const rw = tr.read ? 1 : 0;
    const tenBit = tr.address > 0x7f;
    const addrBytes = tenBit
      ? [0xf0 | (((tr.address >> 8) & 3) << 1) | rw, tr.address & 0xff]
      : [((tr.address & 0x7f) << 1) | rw];
    let t = this.i2cByte(scl, sda, start, addrBytes[0], tr.nackAddress ? 1 : 0, q);
    if (tr.nackAddress) return t;
    for (let k = 1; k < addrBytes.length; k++) t = this.i2cByte(scl, sda, t, addrBytes[k], 0, q);
    tr.data.forEach((byte, k) => {
      const ack: Level = tr.read && k === tr.data.length - 1 ? 1 : 0;
      t = this.i2cByte(scl, sda, t, byte & 0xff, ack, q);
    });
    return t;
  }

  private autoIdle(ch: number, level: Level): void {
    if (!this.explicitIdle[ch] && this.events[ch].samples.length === 0) this.idleLevels[ch] = level;
  }

  private push(ch: number, time: number, level: Level): void {
    const s = Math.round(time * this.sampleRate);
    const ev = this.events[ch];
    const last = ev.samples.length - 1;
    if (last >= 0 && s < ev.samples[last]) ev.sorted = false;
    ev.samples.push(s);
    ev.levels.push(level);
  }

  private checkChannel(ch: number): void {
    if (!Number.isInteger(ch) || ch < 0 || ch >= this.channelCount) {
      throw new RangeError(`Channel ${ch} is outside 0..${this.channelCount - 1}`);
    }
  }
}

function parityBit(parity: 'odd' | 'even' | 'zero' | 'one', ones: number): Level {
  switch (parity) {
    case 'odd':
      return ones % 2 === 0 ? 1 : 0;
    case 'even':
      return (ones % 2) as Level;
    case 'zero':
      return 0;
    case 'one':
      return 1;
  }
}

function bitOf(value: number, idx: number): Level {
  return (Math.floor(value / 2 ** idx) % 2) as Level;
}

/** Event indices sorted by sample; ties keep insertion order (the later event wins). */
function sortedOrder(samples: readonly number[]): number[] {
  const order = samples.map((_, i) => i);
  order.sort((a, b) => samples[a] - samples[b] || a - b);
  return order;
}
