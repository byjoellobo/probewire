/**
 * UART (asynchronous serial) decoder.
 *
 * Each frame starts at a start-bit edge; every bit is sampled at its centre.
 * Idle stretches are skipped with LogicPyramid.findLevel, so long captures
 * with sparse traffic decode quickly.
 */
import type { LogicPyramid } from '../core/pyramid';
import {
  DATA_FORMAT_OPTION,
  formatValue,
  formatValueShort,
  readOption,
  type Annotation,
  type AnnotationKind,
  type DataFormat,
  type DecodeOutput,
  type DecoderDef,
  type NumberOptionSpec,
  type SelectOptionSpec,
} from './types';

type Parity = 'none' | 'odd' | 'even' | 'zero' | 'one';

const BAUD: NumberOptionSpec = { kind: 'number', id: 'baud', label: 'Baud rate', default: 115200, min: 1, step: 1, unit: 'Bd' };
const DATA_BITS: SelectOptionSpec = {
  kind: 'select',
  id: 'dataBits',
  label: 'Data bits',
  default: '8',
  choices: ['5', '6', '7', '8', '9'].map((v) => ({ value: v, label: v })),
};
const PARITY: SelectOptionSpec = {
  kind: 'select',
  id: 'parity',
  label: 'Parity',
  default: 'none',
  choices: [
    { value: 'none', label: 'None' },
    { value: 'odd', label: 'Odd' },
    { value: 'even', label: 'Even' },
    { value: 'zero', label: 'Always 0 (space)' },
    { value: 'one', label: 'Always 1 (mark)' },
  ],
};
const STOP_BITS: SelectOptionSpec = {
  kind: 'select',
  id: 'stopBits',
  label: 'Stop bits',
  default: '1',
  choices: ['1', '1.5', '2'].map((v) => ({ value: v, label: v })),
};
const BIT_ORDER: SelectOptionSpec = {
  kind: 'select',
  id: 'bitOrder',
  label: 'Bit order',
  default: 'lsb',
  choices: [
    { value: 'lsb', label: 'LSB first' },
    { value: 'msb', label: 'MSB first' },
  ],
};
const INVERT: SelectOptionSpec = {
  kind: 'select',
  id: 'invert',
  label: 'Inverted',
  default: 'no',
  choices: [
    { value: 'no', label: 'No' },
    { value: 'yes', label: 'Yes' },
  ],
};

const ROW_RX = 0;
const ROW_RX_BITS = 1;
const ROW_TX = 2;
const ROW_TX_BITS = 3;

interface UartConfig {
  readonly bitW: number;
  readonly dataBits: number;
  readonly parity: Parity;
  readonly stopBits: number;
  readonly msb: boolean;
  readonly invert: boolean;
  readonly format: DataFormat;
}

interface LineTarget {
  readonly ch: number;
  readonly dataRow: number;
  readonly bitsRow: number;
}

function ann(start: number, end: number, row: number, kind: AnnotationKind, texts: readonly string[], value?: number): Annotation {
  return { start, end: Math.max(end, start + 1), row, kind, texts, value };
}

function expectedParity(parity: Parity, ones: number): number {
  switch (parity) {
    case 'odd':
      return ones % 2 === 0 ? 1 : 0;
    case 'even':
      return ones % 2;
    case 'zero':
      return 0;
    case 'one':
      return 1;
    default:
      return -1;
  }
}

/** Decodes every frame on one line, appending annotations to `out`. */
function decodeLine(p: LogicPyramid, target: LineTarget, cfg: UartConfig, out: Annotation[]): void {
  const n = p.length;
  const { ch, dataRow, bitsRow } = target;
  const idle = (cfg.invert ? 0 : 1) as 0 | 1;
  const startLvl = (1 - idle) as 0 | 1;
  const flip = cfg.invert ? 1 : 0;
  const parityBits = cfg.parity === 'none' ? 0 : 1;
  const frameBits = 1 + cfg.dataBits + parityBits + cfg.stopBits;
  const logical = (i: number): number => p.bit(ch, i) ^ flip;

  let pos = p.findLevel(ch, idle, 0);
  while (pos >= 0) {
    const s = p.findLevel(ch, startLvl, pos);
    if (s < 0) break;
    const at = (bitPos: number): number => Math.floor(s + bitPos * cfg.bitW);
    const edge = (bitPos: number): number => Math.round(s + bitPos * cfg.bitW);
    const stopMid = at(1 + cfg.dataBits + parityBits + 0.5);
    if (stopMid >= n) break;
    if (logical(at(0.5)) !== 0) {
      // Glitch shorter than half a bit: skip it.
      pos = p.findLevel(ch, idle, s);
      continue;
    }

    let value = 0;
    let ones = 0;
    const bits: number[] = [];
    for (let b = 0; b < cfg.dataBits; b++) {
      const v = logical(at(1.5 + b));
      bits.push(v);
      ones += v;
      value = cfg.msb ? value * 2 + v : value + v * 2 ** b;
    }
    const parityValue = parityBits ? logical(at(1.5 + cfg.dataBits)) : -1;
    const stopValue = logical(stopMid);

    if (stopValue === 0) {
      const nextIdle = p.findLevel(ch, idle, s);
      const lowEnd = nextIdle < 0 ? n : nextIdle;
      if (lowEnd - s > frameBits * cfg.bitW) {
        out.push(ann(s, lowEnd, dataRow, 'control', ['Break', 'Brk', 'B']));
        if (nextIdle < 0) break;
        pos = nextIdle;
        continue;
      }
    }

    // Bits row
    out.push(ann(edge(0), edge(1), bitsRow, 'bit', ['Start bit', 'Start', 'S']));
    // Data row
    const dataStart = edge(1);
    const dataEnd = edge(1 + cfg.dataBits);
    out.push(
      ann(dataStart, dataEnd, dataRow, 'data', [formatValue(value, cfg.dataBits, cfg.format), formatValueShort(value, cfg.dataBits, cfg.format)], value),
    );
    bits.forEach((v, b) => out.push(ann(edge(1 + b), edge(2 + b), bitsRow, 'bit', [String(v)])));

    if (parityBits) {
      const pStart = edge(1 + cfg.dataBits);
      const pEnd = edge(2 + cfg.dataBits);
      out.push(ann(pStart, pEnd, bitsRow, 'bit', [`Parity bit: ${parityValue}`, `P: ${parityValue}`, 'P']));
      if (parityValue !== expectedParity(cfg.parity, ones)) {
        out.push(ann(pStart, pEnd, dataRow, 'error', ['Parity error', 'PE', 'P']));
      }
    }

    const stopStart = edge(1 + cfg.dataBits + parityBits);
    const stopEnd = edge(frameBits);
    out.push(ann(stopStart, stopEnd, bitsRow, 'bit', ['Stop bit', 'Stop', 'T']));
    if (stopValue !== 1) {
      out.push(ann(stopStart, stopEnd, dataRow, 'error', ['Frame error', 'FE', 'F']));
      pos = p.findLevel(ch, idle, stopMid);
    } else {
      pos = stopMid;
    }
  }
}

function readConfig(sampleRate: number, options: Readonly<Record<string, number | string>>): UartConfig {
  const baud = readOption<number>(options, BAUD);
  return {
    bitW: sampleRate / baud,
    dataBits: Number(readOption<string>(options, DATA_BITS)),
    parity: readOption<string>(options, PARITY) as Parity,
    stopBits: Number(readOption<string>(options, STOP_BITS)),
    msb: readOption<string>(options, BIT_ORDER) === 'msb',
    invert: readOption<string>(options, INVERT) === 'yes',
    format: readOption<string>(options, DATA_FORMAT_OPTION) as DataFormat,
  };
}

export const uartDecoder: DecoderDef = {
  id: 'uart',
  name: 'UART',
  longName: 'Universal Asynchronous Receiver/Transmitter',
  description: 'Asynchronous serial: start bit, 5 to 9 data bits, optional parity, stop bits.',
  channels: [
    { id: 'rx', label: 'RX', required: false, description: 'Data received by the device under test' },
    { id: 'tx', label: 'TX', required: false, description: 'Data transmitted by the device under test' },
  ],
  options: [BAUD, DATA_BITS, PARITY, STOP_BITS, BIT_ORDER, INVERT, DATA_FORMAT_OPTION],
  rows: [
    { id: 'rx', label: 'RX' },
    { id: 'rx-bits', label: 'RX bits' },
    { id: 'tx', label: 'TX' },
    { id: 'tx-bits', label: 'TX bits' },
  ],
  decode(input, channels, options): DecodeOutput {
    const warnings: string[] = [];
    const targets: LineTarget[] = [];
    if (channels.rx !== undefined) targets.push({ ch: channels.rx, dataRow: ROW_RX, bitsRow: ROW_RX_BITS });
    if (channels.tx !== undefined) targets.push({ ch: channels.tx, dataRow: ROW_TX, bitsRow: ROW_TX_BITS });
    if (targets.length === 0) return { annotations: [], warnings: ['Assign at least one of RX or TX.'] };

    const baud = readOption<number>(options, BAUD);
    if (!(baud > 0)) return { annotations: [], warnings: [`Baud rate must be positive (got ${baud}).`] };
    const cfg = readConfig(input.sampleRate, options);
    if (cfg.bitW < 2) {
      return { annotations: [], warnings: [`Sample rate is too low for ${baud} Bd: need at least 2 samples per bit.`] };
    }
    if (input.sampleRate < 4 * baud) {
      warnings.push(`Sample rate is less than 4x the baud rate; decoding may be unreliable.`);
    }

    const out: Annotation[] = [];
    for (const target of targets) decodeLine(input.pyramid, target, cfg, out);
    out.sort((a, b) => a.start - b.start);
    return { annotations: out, warnings };
  },
};
