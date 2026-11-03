/**
 * SPI decoder.
 *
 * Samples MOSI and MISO on the sampling clock edge (rising when CPOL == CPHA,
 * falling otherwise) while chip select is asserted. Without a CS channel the
 * bus is treated as always selected and words are framed from the first
 * sampling edge.
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

const MODE: SelectOptionSpec = {
  kind: 'select',
  id: 'mode',
  label: 'Mode (CPOL, CPHA)',
  default: '0',
  choices: [
    { value: '0', label: 'Mode 0 (0, 0)' },
    { value: '1', label: 'Mode 1 (0, 1)' },
    { value: '2', label: 'Mode 2 (1, 0)' },
    { value: '3', label: 'Mode 3 (1, 1)' },
  ],
};
const CS_POLARITY: SelectOptionSpec = {
  kind: 'select',
  id: 'csPolarity',
  label: 'CS polarity',
  default: 'active-low',
  choices: [
    { value: 'active-low', label: 'Active low' },
    { value: 'active-high', label: 'Active high' },
  ],
};
const BIT_ORDER: SelectOptionSpec = {
  kind: 'select',
  id: 'bitOrder',
  label: 'Bit order',
  default: 'msb',
  choices: [
    { value: 'msb', label: 'MSB first' },
    { value: 'lsb', label: 'LSB first' },
  ],
};
const WORD_SIZE: NumberOptionSpec = { kind: 'number', id: 'wordSize', label: 'Word size', default: 8, min: 4, max: 32, step: 1, unit: 'bits' };

const ROW_MOSI = 0;
const ROW_MISO = 1;
const ROW_TRANSFERS = 2;

interface SpiPinsAssigned {
  readonly clk: number;
  readonly mosi?: number;
  readonly miso?: number;
  readonly cs?: number;
}

interface SpiConfig {
  readonly sampleRising: boolean;
  readonly csActive: 0 | 1;
  readonly msb: boolean;
  readonly wordSize: number;
  readonly format: DataFormat;
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

class SpiDecoderState {
  readonly mosiRow: Annotation[] = [];
  readonly misoRow: Annotation[] = [];
  readonly transfers: Annotation[] = [];
  private count = 0;
  private mosiVal = 0;
  private misoVal = 0;
  private wordStart = 0;
  private period = 0;
  private transferStart = -1;
  private mosiWords: number[] = [];
  private misoWords: number[] = [];

  constructor(
    private readonly p: LogicPyramid,
    private readonly pins: SpiPinsAssigned,
    private readonly cfg: SpiConfig,
  ) {}

  beginTransfer(j: number): void {
    this.resetWord();
    this.transferStart = j;
    this.mosiWords = [];
    this.misoWords = [];
  }

  endTransfer(j: number): void {
    if (this.count > 0) {
      const row = this.pins.mosi !== undefined ? ROW_MOSI : ROW_MISO;
      const target = row === ROW_MOSI ? this.mosiRow : this.misoRow;
      target.push(ann(this.wordStart, j, row, 'warning', [`Partial word (${this.count} bits)`, 'Partial', '?']));
    }
    this.resetWord();
    if (this.transferStart >= 0 && (this.mosiWords.length > 0 || this.misoWords.length > 0)) {
      this.transfers.push(ann(this.transferStart, j, ROW_TRANSFERS, 'summary', this.transferTexts()));
    }
    this.transferStart = -1;
  }

  sample(j: number): void {
    if (this.count === 0) this.wordStart = j;
    const { mosi, miso } = this.pins;
    const mb = mosi !== undefined ? this.p.bit(mosi, j) : 0;
    const sb = miso !== undefined ? this.p.bit(miso, j) : 0;
    if (this.cfg.msb) {
      this.mosiVal = this.mosiVal * 2 + mb;
      this.misoVal = this.misoVal * 2 + sb;
    } else {
      const weight = 2 ** this.count;
      this.mosiVal += mb * weight;
      this.misoVal += sb * weight;
    }
    this.count++;
    if (this.count === this.cfg.wordSize) this.emitWord(j);
  }

  private emitWord(last: number): void {
    const size = this.cfg.wordSize;
    if (size > 1) this.period = (last - this.wordStart) / (size - 1);
    const end = last + Math.max(1, Math.round(this.period));
    const { mosi, miso } = this.pins;
    if (mosi !== undefined) {
      this.mosiRow.push(ann(this.wordStart, end, ROW_MOSI, 'data', this.wordTexts(this.mosiVal), this.mosiVal));
      this.mosiWords.push(this.mosiVal);
    }
    if (miso !== undefined) {
      this.misoRow.push(ann(this.wordStart, end, ROW_MISO, 'data', this.wordTexts(this.misoVal), this.misoVal));
      this.misoWords.push(this.misoVal);
    }
    this.resetWord();
  }

  private wordTexts(value: number): string[] {
    const { wordSize, format } = this.cfg;
    return [formatValue(value, wordSize, format), formatValueShort(value, wordSize, format)];
  }

  private transferTexts(): string[] {
    const { wordSize, format } = this.cfg;
    const list = (words: readonly number[]): string => words.map((w) => formatValueShort(w, wordSize, format)).join(' ');
    const parts: string[] = [];
    if (this.pins.mosi !== undefined) parts.push(`MOSI: ${list(this.mosiWords)}`);
    if (this.pins.miso !== undefined) parts.push(`MISO: ${list(this.misoWords)}`);
    const words = Math.max(this.mosiWords.length, this.misoWords.length);
    return [parts.join(' | '), `${words} word${words === 1 ? '' : 's'}`];
  }

  private resetWord(): void {
    this.count = 0;
    this.mosiVal = 0;
    this.misoVal = 0;
  }
}

function walk(p: LogicPyramid, pins: SpiPinsAssigned, cfg: SpiConfig, state: SpiDecoderState): void {
  if (p.length === 0) return;
  const { clk, cs } = pins;
  const mask = ((1 << clk) | (cs !== undefined ? 1 << cs : 0)) >>> 0;
  let prevClk = p.bit(clk, 0);
  let prevCs = cs !== undefined ? p.bit(cs, 0) : cfg.csActive;
  let active = prevCs === cfg.csActive;
  if (active && cs !== undefined) state.beginTransfer(0);
  let i = 0;
  for (;;) {
    const j = p.findChange(mask, i);
    if (j < 0) break;
    i = j;
    if (cs !== undefined) {
      const csNow = p.bit(cs, j);
      if (csNow !== prevCs) {
        prevCs = csNow;
        prevClk = p.bit(clk, j);
        if (csNow === cfg.csActive) {
          active = true;
          state.beginTransfer(j);
        } else {
          if (active) state.endTransfer(j);
          active = false;
        }
        continue;
      }
    }
    const clkNow = p.bit(clk, j);
    if (clkNow !== prevClk && active && (clkNow === 1) === cfg.sampleRising) state.sample(j);
    prevClk = clkNow;
  }
  if (active && cs !== undefined) state.endTransfer(p.length);
}

function readConfig(options: Readonly<Record<string, number | string>>): SpiConfig {
  const mode = Number(readOption<string>(options, MODE));
  const cpol = mode >> 1;
  const cpha = mode & 1;
  const size = Math.round(readOption<number>(options, WORD_SIZE));
  return {
    sampleRising: cpol === cpha,
    csActive: readOption<string>(options, CS_POLARITY) === 'active-high' ? 1 : 0,
    msb: readOption<string>(options, BIT_ORDER) !== 'lsb',
    wordSize: Math.min(32, Math.max(4, size)),
    format: readOption<string>(options, DATA_FORMAT_OPTION) as DataFormat,
  };
}

export const spiDecoder: DecoderDef = {
  id: 'spi',
  name: 'SPI',
  longName: 'Serial Peripheral Interface',
  description: 'Synchronous serial bus: clock, MOSI, MISO and an optional chip select.',
  channels: [
    { id: 'clk', label: 'CLK', required: true, description: 'Serial clock' },
    { id: 'mosi', label: 'MOSI', required: false, description: 'Controller out, peripheral in' },
    { id: 'miso', label: 'MISO', required: false, description: 'Controller in, peripheral out' },
    { id: 'cs', label: 'CS', required: false, description: 'Chip select' },
  ],
  options: [MODE, CS_POLARITY, BIT_ORDER, WORD_SIZE, DATA_FORMAT_OPTION],
  rows: [
    { id: 'mosi', label: 'MOSI' },
    { id: 'miso', label: 'MISO' },
    { id: 'transfers', label: 'Transfers' },
  ],
  decode(input, channels, options): DecodeOutput {
    const { clk, mosi, miso, cs } = channels;
    if (clk === undefined) return { annotations: [], warnings: ['Assign the CLK channel.'] };
    if (mosi === undefined && miso === undefined) return { annotations: [], warnings: ['Assign MOSI and/or MISO.'] };
    const cfg = readConfig(options);
    const warnings: string[] = [];
    const size = readOption<number>(options, WORD_SIZE);
    if (size !== cfg.wordSize) warnings.push(`Word size ${size} is outside 4..32; using ${cfg.wordSize}.`);
    const pins: SpiPinsAssigned = { clk, mosi, miso, cs };
    const state = new SpiDecoderState(input.pyramid, pins, cfg);
    walk(input.pyramid, pins, cfg, state);
    const annotations = [...clampRow(state.mosiRow), ...clampRow(state.misoRow), ...state.transfers].sort((a, b) => a.start - b.start);
    return { annotations, warnings };
  },
};
