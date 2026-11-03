import { describe, expect, it } from 'vitest';
import { LogicPyramid } from '../core/pyramid';
import { SignalBuilder, type I2cSynthTransaction } from '../core/synth';
import { i2cDecoder } from './i2c';
import type { DecodeOutput, OptionValues } from './types';

const BITS = 0;
const FRAMES = 1;
const TRANSACTIONS = 2;
const RATE = 4_000_000;

function run(transactions: readonly I2cSynthTransaction[], options: OptionValues = {}): DecodeOutput {
  const b = new SignalBuilder(RATE, 40_000, 2);
  b.i2c(0, 1, 0.00002, transactions, 100_000);
  return i2cDecoder.decode({ pyramid: new LogicPyramid(b.build()), sampleRate: RATE }, { scl: 0, sda: 1 }, options);
}

const frames = (out: DecodeOutput): string[] => out.annotations.filter((a) => a.row === FRAMES).map((a) => a.texts[a.texts.length - 1]);
const longFrames = (out: DecodeOutput): string[] => out.annotations.filter((a) => a.row === FRAMES).map((a) => a.texts[0]);
const transactions = (out: DecodeOutput): string[] => out.annotations.filter((a) => a.row === TRANSACTIONS).map((a) => a.texts[0]);

describe('I2C decoder', () => {
  it('decodes a write', () => {
    const out = run([{ address: 0x50, read: false, data: [0x00, 0x10, 0xab] }]);
    expect(longFrames(out)).toEqual([
      'Start',
      'Address write: 0x50',
      'ACK',
      'Data write: 0x00',
      'ACK',
      'Data write: 0x10',
      'ACK',
      'Data write: 0xAB',
      'ACK',
      'Stop',
    ]);
    expect(transactions(out)).toEqual(['Write 0x50: 00 10 AB']);
    expect(out.annotations.filter((a) => a.row === BITS)).toHaveLength(36);
    expect(out.warnings).toEqual([]);
  });

  it('decodes a read with NACK on the last byte', () => {
    const out = run([{ address: 0x68, read: true, data: [0x12, 0x34] }]);
    expect(frames(out)).toEqual(['S', '68', 'A', '12', 'A', '34', 'N', 'P']);
    expect(longFrames(out)[1]).toBe('Address read: 0x68');
    expect(longFrames(out)[3]).toBe('Data read: 0x12');
    expect(transactions(out)).toEqual(['Read 0x68: 12 34']);
  });

  it('decodes a repeated start', () => {
    const out = run([
      { address: 0x50, read: false, data: [0x00] },
      { address: 0x50, read: true, data: [0xde, 0xad] },
    ]);
    expect(frames(out)).toEqual(['S', '50', 'A', '00', 'A', 'S', '50', 'A', 'DE', 'A', 'AD', 'N', 'P']);
    expect(longFrames(out)[5]).toBe('Repeated start');
    expect(transactions(out)).toEqual(['Write 0x50: 00', 'Read 0x50: DE AD']);
  });

  it('reports an address NACK', () => {
    const out = run([{ address: 0x3c, read: false, data: [1, 2], nackAddress: true }]);
    expect(frames(out)).toEqual(['S', '3C', 'N', 'P']);
    expect(transactions(out)).toEqual(['Write 0x3C: address NACK']);
  });

  it('decodes a 10-bit address', () => {
    const out = run([{ address: 0x2a5, read: false, data: [0x77] }]);
    const addr = out.annotations.filter((a) => a.kind === 'address');
    expect(addr.map((a) => a.value)).toEqual([2, 0x2a5]);
    expect(addr[1].texts[0]).toBe('Address write: 0x2A5');
    expect(transactions(out)).toEqual(['Write 0x2A5: 77']);
  });

  it('shows 8-bit addresses when unshifted', () => {
    const out = run([{ address: 0x50, read: true, data: [0x01] }], { addressFormat: 'unshifted' });
    expect(longFrames(out)[1]).toBe('Address read: 0xA1');
  });

  it('keeps frame annotations non-overlapping and sorted', () => {
    const out = run([
      { address: 0x50, read: false, data: [0x00, 0x01] },
      { address: 0x50, read: true, data: [0x02] },
    ]);
    const rows = out.annotations.filter((a) => a.row === FRAMES);
    for (let k = 1; k < rows.length; k++) expect(rows[k].start).toBeGreaterThanOrEqual(rows[k - 1].end);
    const starts = out.annotations.map((a) => a.start);
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
  });

  it('warns when channels are missing', () => {
    const b = new SignalBuilder(RATE, 10, 2);
    const out = i2cDecoder.decode({ pyramid: new LogicPyramid(b.build()), sampleRate: RATE }, { scl: 0 }, {});
    expect(out.warnings[0]).toMatch(/SCL and SDA/);
    expect(out.annotations).toEqual([]);
  });
});
