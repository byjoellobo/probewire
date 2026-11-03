import { describe, expect, it } from 'vitest';
import { LogicPyramid } from './pyramid';

function runs(n: number, seed: number): Uint16Array {
  let s = seed;
  const out = new Uint16Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    if (s % 97 === 0) v = s & 0xffff;
    out[i] = v;
  }
  return out;
}

function bruteForce(words: Uint16Array, mask: number, from: number, low: number): number {
  for (let i = from - 1; i >= low; i--) if (((words[i] ^ words[from]) & mask) !== 0) return i;
  return -1;
}

describe('LogicPyramid.findPrevChange', () => {
  it.each([1, 31, 32, 33, 129, 1000, 4097, 70001])('matches brute force for %i samples', (n) => {
    const words = runs(n, n);
    const pyr = new LogicPyramid(words);
    const probes = [0, 1, n - 1, Math.floor(n / 2), Math.floor(n / 3), 32, 127, 128, 1024];
    for (const from of probes.filter((p) => p < n)) {
      for (const mask of [1, 0x8000, 0x00f0, 0xffff]) {
        for (const low of [0, Math.floor(from / 2)]) {
          expect(pyr.findPrevChange(mask, from, low)).toBe(bruteForce(words, mask, from, low));
        }
      }
    }
  });

  it('returns -1 at the start and outside the capture', () => {
    const pyr = new LogicPyramid(new Uint8Array([1, 0, 1]));
    expect(pyr.findPrevChange(1, 0)).toBe(-1);
    expect(pyr.findPrevChange(1, 3)).toBe(-1);
    expect(pyr.findPrevChange(1, 2)).toBe(1);
  });
});
