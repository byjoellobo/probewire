import { describe, expect, it } from 'vitest';
import { SignalBuilder } from './synth';

const bit = (w: ArrayLike<number>, ch: number, i: number): number => (w[i] >>> ch) & 1;

describe('SignalBuilder', () => {
  it('picks word size from channel count', () => {
    expect(new SignalBuilder(1000, 10, 8).build()).toBeInstanceOf(Uint8Array);
    expect(new SignalBuilder(1000, 10, 9).build()).toBeInstanceOf(Uint16Array);
    expect(new SignalBuilder(1000, 10, 24).build()).toBeInstanceOf(Uint32Array);
  });

  it('renders idle levels and raw edges, clipping events past the end', () => {
    const b = new SignalBuilder(1000, 10, 2).idle(0, 1).level(0, 0.003, 0).level(1, 0.005, 1).level(1, 0.5, 0);
    const w = b.build();
    expect(Array.from({ length: 10 }, (_, i) => bit(w, 0, i))).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from({ length: 10 }, (_, i) => bit(w, 1, i))).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  });

  it('sorts out-of-order events', () => {
    const w = new SignalBuilder(1000, 8, 1).level(0, 0.006, 0).level(0, 0.002, 1).build();
    expect(Array.from({ length: 8 }, (_, i) => bit(w, 0, i))).toEqual([0, 0, 1, 1, 1, 1, 0, 0]);
  });

  it('generates a UART 8N1 frame with idle-high line', () => {
    // 1 sample per bit to make the pattern easy to read.
    const b = new SignalBuilder(1000, 14, 1);
    const end = b.uart(0, 0.002, [0x35], { baud: 1000 });
    const words = b.build();
    // idle, idle, start, LSB-first 0x35 = 1 0 1 0 1 1 0 0, stop, idle...
    expect(Array.from({ length: 14 }, (_, i) => bit(words, 0, i))).toEqual([1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 1]);
    expect(end).toBeCloseTo(0.012, 9);
  });

  it('uses channel 31 in 32-bit words', () => {
    const w = new SignalBuilder(1000, 4, 32).level(31, 0.001, 1).build();
    expect(Array.from(w)).toEqual([0, 0x80000000, 0x80000000, 0x80000000]);
  });

  it('generates a clock', () => {
    const b = new SignalBuilder(1000, 8, 1);
    b.clock(0, 0, 0.008, 250);
    const w = b.build();
    expect(Array.from(w)).toEqual([1, 1, 0, 0, 1, 1, 0, 0]);
  });

  it('leaves I2C lines high after a transaction', () => {
    const b = new SignalBuilder(1_000_000, 200, 2);
    const end = b.i2c(0, 1, 0.000005, [{ address: 0x50, read: false, data: [0x12] }], 100_000);
    const w = b.build();
    expect(end).toBeGreaterThan(0.000005);
    expect(bit(w, 0, 0)).toBe(1);
    expect(bit(w, 1, 0)).toBe(1);
    expect(bit(w, 0, 199)).toBe(1);
    expect(bit(w, 1, 199)).toBe(1);
  });

  it('idles SPI CS inactive and CLK at CPOL', () => {
    const b = new SignalBuilder(1_000_000, 100, 4);
    b.spi({ cs: 0, clk: 1, mosi: 2 }, 0.00001, [0xa5], [], { freq: 250_000, mode: 3 });
    const w = b.build();
    expect(bit(w, 0, 0)).toBe(1);
    expect(bit(w, 1, 0)).toBe(1);
    expect(bit(w, 0, 20)).toBe(0);
  });

  it('rejects invalid arguments', () => {
    expect(() => new SignalBuilder(0, 10, 1)).toThrow(RangeError);
    expect(() => new SignalBuilder(1000, 10, 33)).toThrow(RangeError);
    expect(() => new SignalBuilder(1000, 10, 2).level(2, 0, 1)).toThrow(RangeError);
    expect(() => new SignalBuilder(1000, 10, 1).uart(0, 0, [1], { baud: 100, dataBits: 10 })).toThrow(RangeError);
  });
});
