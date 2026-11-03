import { describe, expect, it } from 'vitest';
import { LogicPyramid } from '../core/pyramid';
import { SignalBuilder, type SpiPins, type SpiSynthOptions } from '../core/synth';
import { spiDecoder } from './spi';
import type { Annotation, DecodeOutput, OptionValues } from './types';

const MOSI = 0;
const MISO = 1;
const TRANSFERS = 2;
const RATE = 8_000_000;
const PINS: SpiPins = { cs: 0, clk: 1, mosi: 2, miso: 3 };
const CHANNELS = { cs: 0, clk: 1, mosi: 2, miso: 3 };

function run(
  mosi: number[],
  miso: number[],
  synth: Omit<SpiSynthOptions, 'freq'>,
  options: OptionValues,
  pins: SpiPins = PINS,
  channels: Record<string, number | undefined> = CHANNELS,
): DecodeOutput {
  const b = new SignalBuilder(RATE, 4000, 4);
  b.spi(pins, 0.00001, mosi, miso, { freq: 1_000_000, ...synth });
  return spiDecoder.decode({ pyramid: new LogicPyramid(b.build()), sampleRate: RATE }, channels, options);
}

const values = (out: DecodeOutput, row: number, kind: Annotation['kind'] = 'data'): Array<number | undefined> =>
  out.annotations.filter((a) => a.row === row && a.kind === kind).map((a) => a.value);

describe('SPI decoder', () => {
  for (const mode of [0, 1, 2, 3] as const) {
    it(`decodes mode ${mode}`, () => {
      const out = run([0x9f, 0x00, 0x00], [0xff, 0xef, 0x40], { mode }, { mode: String(mode) });
      expect(values(out, MOSI)).toEqual([0x9f, 0x00, 0x00]);
      expect(values(out, MISO)).toEqual([0xff, 0xef, 0x40]);
      const transfers = out.annotations.filter((a) => a.row === TRANSFERS);
      expect(transfers.map((a) => a.texts[0])).toEqual(['MOSI: 9F 00 00 | MISO: FF EF 40']);
      expect(out.warnings).toEqual([]);
    });
  }

  it('decodes LSB-first', () => {
    const out = run([0x01, 0x80, 0x3c], [0x12, 0x34, 0x56], { bitOrder: 'lsb' }, { bitOrder: 'lsb' });
    expect(values(out, MOSI)).toEqual([0x01, 0x80, 0x3c]);
    expect(values(out, MISO)).toEqual([0x12, 0x34, 0x56]);
  });

  it('decodes 16-bit and 32-bit words', () => {
    const out16 = run([0x1234, 0xbeef], [0xffff, 0x0001], { wordSize: 16 }, { wordSize: 16 });
    expect(values(out16, MOSI)).toEqual([0x1234, 0xbeef]);
    expect(values(out16, MISO)).toEqual([0xffff, 0x0001]);
    expect(out16.annotations.find((a) => a.row === MOSI)?.texts[0]).toBe('0x1234');
    const out32 = run([0xdeadbeef], [0x80000001], { wordSize: 32 }, { wordSize: 32 });
    expect(values(out32, MOSI)).toEqual([0xdeadbeef]);
    expect(values(out32, MISO)).toEqual([0x80000001]);
  });

  it('decodes without a CS line', () => {
    const pins: SpiPins = { clk: 1, mosi: 2, miso: 3 };
    const out = run([0xa5, 0x5a], [0x0f, 0xf0], { mode: 1 }, { mode: '1' }, pins, { clk: 1, mosi: 2, miso: 3 });
    expect(values(out, MOSI)).toEqual([0xa5, 0x5a]);
    expect(values(out, MISO)).toEqual([0x0f, 0xf0]);
    expect(out.annotations.filter((a) => a.row === TRANSFERS)).toEqual([]);
  });

  it('decodes MOSI only', () => {
    const out = run([0x42], [], {}, {}, { cs: 0, clk: 1, mosi: 2 }, { cs: 0, clk: 1, mosi: 2 });
    expect(values(out, MOSI)).toEqual([0x42]);
    expect(values(out, MISO)).toEqual([]);
    expect(out.annotations.filter((a) => a.row === TRANSFERS)[0].texts[0]).toBe('MOSI: 42');
  });

  it('reports a partial word when CS deasserts', () => {
    const out = run([0xabc], [0], { wordSize: 12 }, { wordSize: 8 });
    expect(values(out, MOSI)).toEqual([0xab]);
    const partial = out.annotations.filter((a) => a.kind === 'warning');
    expect(partial).toHaveLength(1);
    expect(partial[0].texts[0]).toBe('Partial word (4 bits)');
  });

  it('honours active-high CS', () => {
    const out = run([0x11, 0x22], [0, 0], { csActiveHigh: true }, { csPolarity: 'active-high' });
    expect(values(out, MOSI)).toEqual([0x11, 0x22]);
  });

  it('keeps word annotations non-overlapping', () => {
    const out = run([1, 2, 3, 4], [5, 6, 7, 8], {}, {});
    const row = out.annotations.filter((a) => a.row === MOSI);
    for (let k = 1; k < row.length; k++) expect(row[k].start).toBeGreaterThanOrEqual(row[k - 1].end);
  });

  it('warns about missing channels and bad word sizes', () => {
    const b = new SignalBuilder(RATE, 10, 4);
    const input = { pyramid: new LogicPyramid(b.build()), sampleRate: RATE };
    expect(spiDecoder.decode(input, { mosi: 2 }, {}).warnings[0]).toMatch(/CLK/);
    expect(spiDecoder.decode(input, { clk: 1 }, {}).warnings[0]).toMatch(/MOSI/);
    expect(spiDecoder.decode(input, { clk: 1, mosi: 2 }, { wordSize: 64 }).warnings[0]).toMatch(/4\.\.32/);
  });
});
