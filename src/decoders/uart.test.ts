import { describe, expect, it } from 'vitest';
import { LogicPyramid } from '../core/pyramid';
import { SignalBuilder, type UartSynthOptions } from '../core/synth';
import type { Annotation, DecodeOutput, OptionValues } from './types';
import { uartDecoder } from './uart';

const RX = 0;
const RX_BITS = 1;
const TX = 2;

function decode(b: SignalBuilder, rate: number, channels: Record<string, number | undefined>, options: OptionValues = {}): DecodeOutput {
  return uartDecoder.decode({ pyramid: new LogicPyramid(b.build()), sampleRate: rate }, channels, options);
}

const values = (out: DecodeOutput, row: number, kind: Annotation['kind'] = 'data'): Array<number | undefined> =>
  out.annotations.filter((a) => a.row === row && a.kind === kind).map((a) => a.value);

function roundTrip(bytes: number[], rate: number, synth: UartSynthOptions, options: OptionValues): DecodeOutput {
  const b = new SignalBuilder(rate, Math.ceil(rate * ((bytes.length + 4) * 13) / synth.baud), 1);
  b.uart(0, 2 / synth.baud, bytes, synth);
  return decode(b, rate, { rx: 0 }, { baud: synth.baud, ...options });
}

const BYTES = [0x00, 0x55, 0xaa, 0xff, 0x41, 0x0d, 0x80, 0x01];

describe('UART decoder', () => {
  for (const ratio of [4, 8.68, 16, 100]) {
    it(`decodes 8N1 at ${ratio} samples per bit`, () => {
      const baud = 115200;
      const out = roundTrip(BYTES, baud * ratio, { baud }, {});
      expect(values(out, RX)).toEqual(BYTES);
      expect(out.annotations.filter((a) => a.kind === 'error')).toEqual([]);
    });
  }

  it('decodes frames with idle gaps', () => {
    const out = roundTrip(BYTES, 1_000_000, { baud: 9600, gapBits: 3.7 }, {});
    expect(values(out, RX)).toEqual(BYTES);
  });

  it('emits start, data and stop bits in the bits row', () => {
    const out = roundTrip([0x35], 1_000_000, { baud: 115200 }, {});
    const bits = out.annotations.filter((a) => a.row === RX_BITS).map((a) => a.texts[a.texts.length - 1]);
    expect(bits).toEqual(['S', '1', '0', '1', '0', '1', '1', '0', '0', 'T']);
    const data = out.annotations.find((a) => a.row === RX);
    expect(data?.texts).toEqual(['0x35', '35']);
  });

  for (const parity of ['odd', 'even', 'zero', 'one'] as const) {
    it(`checks ${parity} parity`, () => {
      const out = roundTrip(BYTES, 2_000_000, { baud: 115200, parity }, { parity });
      expect(values(out, RX)).toEqual(BYTES);
      expect(out.annotations.filter((a) => a.kind === 'error')).toEqual([]);
    });
  }

  it('flags parity errors', () => {
    const out = roundTrip([0x01, 0x03], 2_000_000, { baud: 115200, parity: 'even' }, { parity: 'odd' });
    expect(values(out, RX)).toEqual([0x01, 0x03]);
    const errors = out.annotations.filter((a) => a.kind === 'error');
    expect(errors).toHaveLength(2);
    expect(errors[0].texts[0]).toBe('Parity error');
  });

  it('decodes MSB-first', () => {
    const out = roundTrip(BYTES, 2_000_000, { baud: 115200, bitOrder: 'msb' }, { bitOrder: 'msb' });
    expect(values(out, RX)).toEqual(BYTES);
  });

  it('decodes an inverted line', () => {
    const out = roundTrip(BYTES, 2_000_000, { baud: 115200, invert: true }, { invert: 'yes' });
    expect(values(out, RX)).toEqual(BYTES);
  });

  it('decodes 9 data bits and 2 stop bits', () => {
    const words = [0x1ff, 0x100, 0x0aa, 0x155];
    const out = roundTrip(words, 2_000_000, { baud: 115200, dataBits: 9, stopBits: 2 }, { dataBits: '9', stopBits: '2' });
    expect(values(out, RX)).toEqual(words);
    expect(out.annotations.find((a) => a.row === RX)?.texts[0]).toBe('0x1FF');
  });

  it('decodes 1.5 stop bits and 5 data bits', () => {
    const words = [0x1f, 0x00, 0x15];
    const out = roundTrip(words, 2_000_000, { baud: 9600, dataBits: 5, stopBits: 1.5 }, { baud: 9600, dataBits: '5', stopBits: '1.5' });
    expect(values(out, RX)).toEqual(words);
  });

  it('reports a frame error and resynchronises', () => {
    const rate = 10_000;
    const b = new SignalBuilder(rate, 400, 1).idle(0, 1);
    // Start bit at 1 ms, bit 0 high, bits 1-7 low, stop bit low for one bit, then idle.
    b.level(0, 0.001, 0).level(0, 0.002, 1).level(0, 0.003, 0).level(0, 0.011, 1);
    b.uart(0, 0.02, [0x42], { baud: 1000 });
    const out = decode(b, rate, { rx: 0 }, { baud: 1000 });
    expect(values(out, RX)).toEqual([0x01, 0x42]);
    const errors = out.annotations.filter((a) => a.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].texts[0]).toBe('Frame error');
  });

  it('detects a break', () => {
    const rate = 10_000;
    const b = new SignalBuilder(rate, 1000, 1).idle(0, 1);
    b.level(0, 0.001, 0).level(0, 0.05, 1);
    b.uart(0, 0.06, [0x55], { baud: 1000 });
    const out = decode(b, rate, { rx: 0 }, { baud: 1000 });
    const brk = out.annotations.filter((a) => a.kind === 'control');
    expect(brk).toHaveLength(1);
    expect(brk[0].texts[0]).toBe('Break');
    expect(brk[0].start).toBe(10);
    expect(brk[0].end).toBe(500);
    expect(values(out, RX)).toEqual([0x55]);
  });

  it('decodes RX and TX together', () => {
    const rate = 1_000_000;
    const b = new SignalBuilder(rate, 20_000, 2);
    b.uart(0, 0.0001, [0x11, 0x22], { baud: 115200 });
    b.uart(1, 0.0002, [0x33], { baud: 115200 });
    const out = decode(b, rate, { rx: 0, tx: 1 });
    expect(values(out, RX)).toEqual([0x11, 0x22]);
    expect(values(out, TX)).toEqual([0x33]);
    const starts = out.annotations.map((a) => a.start);
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
  });

  it('formats as ASCII', () => {
    const out = roundTrip([0x41, 0x0a], 1_000_000, { baud: 115200 }, { format: 'ascii' });
    expect(out.annotations.filter((a) => a.row === RX).map((a) => a.texts[0])).toEqual(["'A'", '\\n']);
  });

  it('warns without channels and on low sample rates', () => {
    const b = new SignalBuilder(1000, 10, 1);
    expect(decode(b, 1000, {}).warnings[0]).toMatch(/RX or TX/);
    const low = roundTrip([0x5a], 3 * 115200, { baud: 115200 }, {});
    expect(low.warnings.length).toBeGreaterThan(0);
    const tooLow = decode(new SignalBuilder(1000, 10, 1), 1000, { rx: 0 }, { baud: 900 });
    expect(tooLow.annotations).toEqual([]);
    expect(tooLow.warnings[0]).toMatch(/too low/);
  });

  it('decodes sparse traffic in a 10M-sample capture quickly', { timeout: 30_000 }, () => {
    const rate = 4_000_000;
    const n = 10_000_000;
    const b = new SignalBuilder(rate, n, 1);
    const payload = Array.from({ length: 20 }, (_, i) => (i * 37) & 0xff);
    for (let k = 0; k < 10; k++) b.uart(0, 0.01 + k * 0.24, payload, { baud: 115200 });
    const pyramid = new LogicPyramid(b.build());
    const t0 = performance.now();
    const out = uartDecoder.decode({ pyramid, sampleRate: rate }, { rx: 0 }, {});
    const elapsed = performance.now() - t0;
    expect(values(out, RX)).toHaveLength(200);
    expect(elapsed).toBeLessThan(1500);
  });
});
