/**
 * I2C decoder.
 *
 * Walks every change on SCL or SDA. START is SDA falling while SCL is high,
 * STOP is SDA rising while SCL is high, and data bits are sampled on SCL
 * rising edges (8 data bits, then the ACK bit). When SCL and SDA change in the
 * same sample the change is treated as an SCL edge.
 */
import type { LogicPyramid } from '../core/pyramid';
import {
  DATA_FORMAT_OPTION,
  formatValue,
  formatValueShort,
  hex,
  readOption,
  type Annotation,
  type AnnotationKind,
  type DataFormat,
  type DecodeOutput,
  type DecoderDef,
  type SelectOptionSpec,
} from './types';

const ADDRESS_FORMAT: SelectOptionSpec = {
  kind: 'select',
  id: 'addressFormat',
  label: 'Address format',
  default: 'shifted',
  choices: [
    { value: 'shifted', label: '7-bit (without R/W)' },
    { value: 'unshifted', label: '8-bit (with R/W bit)' },
  ],
};

const ROW_BITS = 0;
const ROW_FRAMES = 1;
const ROW_TRANSACTIONS = 2;

interface Bit {
  readonly sample: number;
  readonly value: number;
}

interface Segment {
  readonly start: number;
  address?: number;
  addressBits: number;
  read: boolean;
  nackAddress: boolean;
  readonly data: number[];
}

function ann(start: number, end: number, row: number, kind: AnnotationKind, texts: readonly string[], value?: number): Annotation {
  return { start, end: Math.max(end, start + 1), row, kind, texts, value };
}

/** Clamps each annotation's end to the next one's start so a row never overlaps. */
function clampRow(row: Annotation[]): Annotation[] {
  const sorted = [...row].sort((a, b) => a.start - b.start);
  return sorted.map((a, k) => {
    const next = sorted[k + 1];
    if (next && next.start > a.start && a.end > next.start) return { ...a, end: next.start };
    return a;
  });
}

class I2cDecoderState {
  readonly bitsRow: Annotation[] = [];
  readonly frames: Annotation[] = [];
  readonly transactions: Annotation[] = [];
  private active = false;
  private bits: Bit[] = [];
  private byteIndex = 0;
  private tenBitHigh = -1;
  private lastTenBit = -1;
  private period = 0;
  private pendingStart: { start: number; texts: readonly string[] } | undefined;
  private segment: Segment | undefined;

  constructor(
    private readonly p: LogicPyramid,
    private readonly sda: number,
    private readonly shifted: boolean,
    private readonly format: DataFormat,
  ) {}

  onStart(j: number): void {
    const repeated = this.active;
    this.flushPendingStart(j);
    this.closeSegment(j);
    this.active = true;
    this.bits = [];
    this.byteIndex = 0;
    this.tenBitHigh = -1;
    this.pendingStart = { start: j, texts: repeated ? ['Repeated start', 'Sr', 'S'] : ['Start', 'S'] };
    this.segment = { start: j, addressBits: this.shifted ? 7 : 8, read: false, nackAddress: false, data: [] };
  }

  onStop(j: number): void {
    if (!this.active) return;
    this.flushPendingStart(j);
    const len = Math.max(1, Math.round(this.period / 2));
    this.frames.push(ann(j, j + len, ROW_FRAMES, 'control', ['Stop', 'P']));
    this.closeSegment(j);
    this.active = false;
    this.bits = [];
  }

  onRise(j: number): void {
    if (!this.active) return;
    this.flushPendingStart(j);
    this.bits.push({ sample: j, value: this.p.bit(this.sda, j) });
    if (this.bits.length === 9) {
      this.processByte(this.bits);
      this.bits = [];
    }
  }

  finish(end: number): void {
    this.flushPendingStart(end);
    this.closeSegment(end);
  }

  private flushPendingStart(end: number): void {
    if (!this.pendingStart) return;
    this.frames.push(ann(this.pendingStart.start, end, ROW_FRAMES, 'control', this.pendingStart.texts));
    this.pendingStart = undefined;
  }

  private processByte(bits: readonly Bit[]): void {
    let byte = 0;
    for (let k = 0; k < 8; k++) byte = (byte << 1) | bits[k].value;
    const ackBit = bits[8];
    this.period = (ackBit.sample - bits[0].sample) / 8;
    const width = Math.max(1, Math.round(this.period));
    bits.forEach((b, k) => {
      const end = k < 8 ? bits[k + 1].sample : b.sample + width;
      this.bitsRow.push(ann(b.sample, end, ROW_BITS, 'bit', [String(b.value)]));
    });
    const [kind, texts, value] = this.describeByte(byte, ackBit.value === 1);
    this.frames.push(ann(bits[0].sample, ackBit.sample, ROW_FRAMES, kind, texts, value));
    const acked = ackBit.value === 0;
    this.frames.push(ann(ackBit.sample, ackBit.sample + width, ROW_FRAMES, acked ? 'ack' : 'nack', acked ? ['ACK', 'A'] : ['NACK', 'N']));
    this.byteIndex++;
  }

  private describeByte(byte: number, nack: boolean): [AnnotationKind, string[], number] {
    const seg = this.segment;
    if (!seg) return ['data', [formatValue(byte, 8, this.format)], byte];
    if (this.byteIndex === 0) {
      seg.read = (byte & 1) === 1;
      seg.nackAddress = nack;
      if ((byte & 0xf8) === 0xf0) return this.tenBitFirst(seg, byte);
      const addr = this.shifted ? byte >> 1 : byte;
      seg.address = addr;
      return ['address', addressTexts(seg.read, addr, seg.addressBits), addr];
    }
    if (this.tenBitHigh >= 0 && this.byteIndex === 1 && !seg.read) {
      const addr = (this.tenBitHigh << 8) | byte;
      this.tenBitHigh = -1;
      this.lastTenBit = addr;
      seg.address = addr;
      seg.addressBits = 10;
      return ['address', addressTexts(false, addr, 10), addr];
    }
    seg.data.push(byte);
    const dir = seg.read ? 'read' : 'write';
    const long = `Data ${dir}: ${formatValue(byte, 8, this.format)}`;
    const mid = `D${dir === 'read' ? 'R' : 'W'} ${formatValueShort(byte, 8, this.format)}`;
    return ['data', [long, mid, formatValueShort(byte, 8, this.format)], byte];
  }

  private tenBitFirst(seg: Segment, byte: number): [AnnotationKind, string[], number] {
    const high = (byte >> 1) & 3;
    if (!seg.read) {
      this.tenBitHigh = high;
      return ['address', [`10-bit address, high bits: ${high}`, `A10 ${high}`, `${high}`], high];
    }
    const addr = this.lastTenBit >= 0 && this.lastTenBit >> 8 === high ? this.lastTenBit : high << 8;
    seg.address = addr;
    seg.addressBits = 10;
    return ['address', addressTexts(true, addr, 10), addr];
  }

  private closeSegment(end: number): void {
    const seg = this.segment;
    this.segment = undefined;
    if (!seg || seg.address === undefined || end <= seg.start) return;
    const label = seg.read ? 'Read' : 'Write';
    const short = `0x${hex(seg.address, seg.addressBits)}`;
    let texts: string[];
    if (seg.nackAddress) {
      texts = [`${label} ${short}: address NACK`, `${label[0]} ${hex(seg.address, seg.addressBits)} NACK`];
    } else if (seg.data.length === 0) {
      texts = [`${label} ${short}`, `${label[0]} ${hex(seg.address, seg.addressBits)}`];
    } else {
      const data = seg.data.map((v) => formatValueShort(v, 8, this.format)).join(' ');
      texts = [
        `${label} ${short}: ${data}`,
        `${label[0]} ${hex(seg.address, seg.addressBits)}: ${data}`,
        `${label[0]} ${hex(seg.address, seg.addressBits)}`,
      ];
    }
    this.transactions.push(ann(seg.start, end, ROW_TRANSACTIONS, 'summary', texts, seg.address));
  }
}

function addressTexts(read: boolean, addr: number, bits: number): string[] {
  const dir = read ? 'read' : 'write';
  const h = hex(addr, bits);
  return [`Address ${dir}: 0x${h}`, `A${read ? 'R' : 'W'} ${h}`, h];
}

function walk(p: LogicPyramid, scl: number, sda: number, state: I2cDecoderState): void {
  if (p.length === 0) return;
  const mask = ((1 << scl) | (1 << sda)) >>> 0;
  let prevScl = p.bit(scl, 0);
  let prevSda = p.bit(sda, 0);
  let i = 0;
  for (;;) {
    const j = p.findChange(mask, i);
    if (j < 0) break;
    const sclNow = p.bit(scl, j);
    const sdaNow = p.bit(sda, j);
    if (sclNow !== prevScl) {
      if (sclNow === 1) state.onRise(j);
    } else if (sclNow === 1 && sdaNow !== prevSda) {
      if (sdaNow === 0) state.onStart(j);
      else state.onStop(j);
    }
    prevScl = sclNow;
    prevSda = sdaNow;
    i = j;
  }
  state.finish(p.length);
}

export const i2cDecoder: DecoderDef = {
  id: 'i2c',
  name: 'I²C',
  longName: 'Inter-Integrated Circuit',
  description: 'Two-wire bus: START, 7- or 10-bit address with R/W, data bytes with ACK/NACK, STOP.',
  channels: [
    { id: 'scl', label: 'SCL', required: true, description: 'Serial clock' },
    { id: 'sda', label: 'SDA', required: true, description: 'Serial data' },
  ],
  options: [ADDRESS_FORMAT, DATA_FORMAT_OPTION],
  rows: [
    { id: 'bits', label: 'Bits' },
    { id: 'frames', label: 'Frames' },
    { id: 'transactions', label: 'Transactions' },
  ],
  decode(input, channels, options): DecodeOutput {
    const { scl, sda } = channels;
    if (scl === undefined || sda === undefined) return { annotations: [], warnings: ['Assign both SCL and SDA.'] };
    if (scl === sda) return { annotations: [], warnings: ['SCL and SDA must be different channels.'] };
    const shifted = readOption<string>(options, ADDRESS_FORMAT) !== 'unshifted';
    const format = readOption<string>(options, DATA_FORMAT_OPTION) as DataFormat;
    const state = new I2cDecoderState(input.pyramid, sda, shifted, format);
    walk(input.pyramid, scl, sda, state);
    const annotations = [...state.bitsRow, ...clampRow(state.frames), ...state.transactions].sort((a, b) => a.start - b.start);
    return { annotations, warnings: [] };
  },
};
