import { describe, expect, it } from 'vitest';
import { allocWords, type SampleWords } from './capture';
import { AnalogPyramid, LogicPyramid, type Aggregate } from './pyramid';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random words made of runs, so edges are spread at varied distances. */
function randomWords(n: number, bytes: 1 | 2 | 4, rand: () => number): SampleWords {
  const words = allocWords(n, bytes);
  const bitsWide = bytes * 8;
  let i = 0;
  let current = 0;
  while (i < n) {
    const flips = Math.floor(rand() * 3);
    for (let f = 0; f < flips; f++) current ^= 1 << Math.floor(rand() * bitsWide);
    const run = 1 + Math.floor(rand() ** 3 * 300);
    for (let k = 0; k < run && i < n; k++, i++) words[i] = current;
  }
  return words;
}

function bruteAggregate(w: SampleWords, start: number, end: number): Aggregate {
  let or = 0;
  let and = 0xffffffff;
  for (let i = Math.max(0, start); i < Math.min(end, w.length); i++) {
    or |= w[i];
    and &= w[i];
  }
  return { or: or >>> 0, and: and >>> 0 };
}

function bruteChange(w: SampleWords, mask: number, from: number, limit: number): number {
  if (from < 0 || from >= w.length) return -1;
  for (let i = from + 1; i < Math.min(limit, w.length); i++) if (((w[i] ^ w[from]) & mask) !== 0) return i;
  return -1;
}

function bruteLevel(w: SampleWords, ch: number, level: number, from: number, limit: number): number {
  for (let i = Math.max(0, from); i < Math.min(limit, w.length); i++) if (((w[i] >>> ch) & 1) === level) return i;
  return -1;
}

const SIZES = [0, 1, 5, 31, 32, 33, 100, 129, 1000, 4097, 70001];
const WIDTHS: Array<1 | 2 | 4> = [1, 2, 4];

describe('LogicPyramid', () => {
  for (const bytes of WIDTHS) {
    for (const n of SIZES) {
      it(`matches brute force for n=${n}, ${bytes}-byte words`, () => {
        const rand = mulberry32(n * 31 + bytes);
        const w = randomWords(n, bytes, rand);
        const p = new LogicPyramid(w);
        const bits = bytes * 8;
        const out: Aggregate = { or: 0, and: 0 };
        for (let q = 0; q < 300; q++) {
          const a = Math.floor(rand() * (n + 10)) - 5;
          const b = a + Math.floor(rand() * (n + 5));
          expect(p.aggregate(a, b, out)).toEqual(bruteAggregate(w, a, b));

          const ch = Math.floor(rand() * bits);
          const ch2 = Math.floor(rand() * bits);
          const mask = ((1 << ch) | (rand() < 0.5 ? 1 << ch2 : 0)) >>> 0;
          const from = Math.floor(rand() * (n + 2)) - 1;
          const limit = rand() < 0.3 ? from + Math.floor(rand() * 200) : n;
          expect(p.findChange(mask, from, limit)).toBe(bruteChange(w, mask, from, limit));

          const level = rand() < 0.5 ? 0 : 1;
          expect(p.findLevel(ch, level, from, limit)).toBe(bruteLevel(w, ch, level, from, limit));
        }
      });
    }
  }

  it('reads single bits', () => {
    const w = new Uint32Array([0x80000001, 0]);
    const p = new LogicPyramid(w);
    expect(p.bit(0, 0)).toBe(1);
    expect(p.bit(31, 0)).toBe(1);
    expect(p.bit(1, 0)).toBe(0);
    expect(p.bit(31, 1)).toBe(0);
  });

  it('finds a single edge in a long idle capture', () => {
    const w = new Uint8Array(1_000_000);
    w[777_777] = 4;
    const p = new LogicPyramid(w);
    expect(p.findLevel(2, 1, 0)).toBe(777_777);
    expect(p.findChange(4, 0)).toBe(777_777);
    expect(p.findChange(4, 777_777)).toBe(777_778);
    expect(p.findChange(1, 0)).toBe(-1);
  });
});

describe('AnalogPyramid', () => {
  it('matches brute-force min/max', () => {
    const rand = mulberry32(99);
    for (const n of [1, 31, 33, 1000, 5000]) {
      const data = new Float32Array(n).map(() => rand() * 10 - 5);
      const p = new AnalogPyramid(data);
      const out = { min: 0, max: 0 };
      for (let q = 0; q < 200; q++) {
        const a = Math.floor(rand() * n);
        const b = a + 1 + Math.floor(rand() * (n - a));
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = a; i < b; i++) {
          lo = Math.min(lo, data[i]);
          hi = Math.max(hi, data[i]);
        }
        expect(p.range(a, b, out)).toEqual({ min: lo, max: hi });
      }
      expect(p.globalMin).toBe(Math.min(...data));
      expect(p.globalMax).toBe(Math.max(...data));
    }
  });

  it('handles empty data', () => {
    const p = new AnalogPyramid(new Float32Array(0));
    expect(p.globalMin).toBe(0);
    expect(p.globalMax).toBe(0);
  });
});
