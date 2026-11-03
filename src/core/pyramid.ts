/**
 * Multi-resolution summaries of logic and analog sample data.
 *
 * LogicPyramid keeps, for each block of samples, the bitwise OR and AND of all
 * sample words in the block. For channel bit b:
 *   - OR bit clear  => the channel is low for the whole block
 *   - AND bit set   => the channel is high for the whole block
 *   - otherwise     => the channel changes inside the block
 * One pass summarises every channel at once. Level 0 blocks hold BASE_BLOCK
 * samples and every level up is FANOUT times coarser.
 *
 * The same structure lets edge searches skip whole blocks, which is what keeps
 * protocol decoding fast on multi-million-sample captures.
 */
import type { SampleWords } from './capture';

const BASE_BLOCK = 32;
const FANOUT = 4;

interface LogicLevel {
  readonly blockSize: number;
  readonly or: Uint32Array;
  readonly and: Uint32Array;
}

export interface Aggregate {
  /** OR of all words in the range. */
  or: number;
  /** AND of all words in the range. */
  and: number;
}

export class LogicPyramid {
  readonly samples: SampleWords;
  readonly length: number;
  private readonly levels: readonly LogicLevel[];

  constructor(samples: SampleWords) {
    this.samples = samples;
    this.length = samples.length;
    this.levels = buildLogicLevels(samples);
  }

  /** Level (0 or 1) of channel bit `ch` at sample `i`. */
  bit(ch: number, i: number): 0 | 1 {
    return ((this.samples[i] >>> ch) & 1) as 0 | 1;
  }

  /** Exact OR/AND of words in [start, end). Writes into `out` to avoid allocation. */
  aggregate(start: number, end: number, out: Aggregate): Aggregate {
    let or = 0;
    let and = 0xffffffff;
    const s = this.samples;
    const levels = this.levels;
    let i = Math.max(0, start);
    const stop = Math.min(end, this.length);
    while (i < stop) {
      let used = false;
      for (let l = levels.length - 1; l >= 0; l--) {
        const bs = levels[l].blockSize;
        if (i % bs === 0 && i + bs <= stop) {
          const blk = i / bs;
          or |= levels[l].or[blk];
          and &= levels[l].and[blk];
          i += bs;
          used = true;
          break;
        }
      }
      if (!used) {
        const w = s[i];
        or |= w;
        and &= w;
        i++;
      }
    }
    out.or = or >>> 0;
    out.and = and >>> 0;
    return out;
  }

  /**
   * First index i in (from, limit) where (word[i] ^ word[from]) & mask != 0,
   * i.e. the next sample where any masked channel differs from its value at
   * `from`. Returns -1 if none.
   */
  findChange(mask: number, from: number, limit: number = this.length): number {
    if (from < 0 || from >= this.length) return -1;
    const ref = this.samples[from];
    return this.findDiffering(mask, ref, from + 1, limit);
  }

  /** First index i in [from, limit) where channel `ch` equals `level`, or -1. */
  findLevel(ch: number, level: 0 | 1, from: number, limit: number = this.length): number {
    const start = Math.max(0, from);
    if (start >= Math.min(limit, this.length)) return -1;
    const mask = 1 << ch;
    // Searching for `level` means searching for a sample that differs from the opposite level.
    const ref = level ? 0 : mask;
    return this.findDiffering(mask, ref, start, limit);
  }

  /**
   * Last index i in [low, from) where (word[i] ^ word[from]) & mask != 0, i.e.
   * the most recent earlier sample where a masked channel differed from its
   * value at `from`. Returns -1 if none.
   */
  findPrevChange(mask: number, from: number, low = 0): number {
    if (from <= 0 || from >= this.length) return -1;
    return this.findPrevDiffering(mask, this.samples[from], from - 1, low);
  }

  /** Last index i in [low, start] where (word[i] ^ ref) & mask != 0. */
  private findPrevDiffering(mask: number, ref: number, start: number, low: number): number {
    const s = this.samples;
    const levels = this.levels;
    const last = this.length - 1;
    const floor = Math.max(0, low);
    const refMasked = (ref & mask) >>> 0;
    const notRef = (~ref & mask) >>> 0;
    let i = Math.min(start, last);
    let maxLevel = levels.length - 1;
    while (i >= floor) {
      // Use the coarsest block that ends exactly at i (the final block may be partial).
      let level = -1;
      for (let l = maxLevel; l >= 0; l--) {
        if ((i + 1) % levels[l].blockSize === 0 || i === last) {
          level = l;
          break;
        }
      }
      if (level < 0) {
        if (((s[i] ^ ref) & mask) !== 0) return i;
        i--;
        continue;
      }
      const lv = levels[level];
      const blk = Math.floor(i / lv.blockSize);
      const blockStart = blk * lv.blockSize;
      const differs = (refMasked & ~lv.and[blk]) | (notRef & lv.or[blk]);
      if (differs === 0) {
        i = blockStart - 1;
        maxLevel = levels.length - 1;
        continue;
      }
      if (level === 0) {
        const end = Math.max(blockStart, floor);
        for (let j = i; j >= end; j--) {
          if (((s[j] ^ ref) & mask) !== 0) return j;
        }
        i = end - 1;
        maxLevel = levels.length - 1;
        continue;
      }
      maxLevel = level - 1;
    }
    return -1;
  }

  /** First index i in [start, limit) where (word[i] ^ ref) & mask != 0. */
  private findDiffering(mask: number, ref: number, start: number, limit: number): number {
    const s = this.samples;
    const levels = this.levels;
    const stop = Math.min(limit, this.length);
    const refMasked = (ref & mask) >>> 0;
    const notRef = (~ref & mask) >>> 0;
    let i = start;
    let maxLevel = levels.length - 1;
    while (i < stop) {
      let level = -1;
      for (let l = maxLevel; l >= 0; l--) {
        if (i % levels[l].blockSize === 0) {
          level = l;
          break;
        }
      }
      if (level < 0) {
        if (((s[i] ^ ref) & mask) !== 0) return i;
        i++;
        continue;
      }
      const lv = levels[level];
      const blk = i / lv.blockSize;
      // A block can contain a differing sample if some ref-high bit has AND=0
      // or some ref-low bit has OR=1.
      const differs = (refMasked & ~lv.and[blk]) | (notRef & lv.or[blk]);
      if (differs === 0) {
        i += lv.blockSize;
        maxLevel = levels.length - 1;
        continue;
      }
      if (level === 0) {
        const end = Math.min(i + lv.blockSize, stop);
        for (let j = i; j < end; j++) {
          if (((s[j] ^ ref) & mask) !== 0) return j;
        }
        i = end;
        maxLevel = levels.length - 1;
        continue;
      }
      maxLevel = level - 1;
    }
    return -1;
  }
}

function buildLogicLevels(samples: SampleWords): LogicLevel[] {
  const n = samples.length;
  const levels: LogicLevel[] = [];
  if (n === 0) return levels;

  let blockSize = BASE_BLOCK;
  let count = Math.ceil(n / blockSize);
  let or = new Uint32Array(count);
  let and = new Uint32Array(count);
  for (let b = 0; b < count; b++) {
    const start = b * blockSize;
    const end = Math.min(start + blockSize, n);
    let o = 0;
    let a = 0xffffffff;
    for (let i = start; i < end; i++) {
      const w = samples[i];
      o |= w;
      a &= w;
    }
    or[b] = o;
    and[b] = a;
  }
  levels.push({ blockSize, or, and });

  while (count > 1) {
    const prevOr = or;
    const prevAnd = and;
    const prevCount = count;
    blockSize *= FANOUT;
    count = Math.ceil(prevCount / FANOUT);
    or = new Uint32Array(count);
    and = new Uint32Array(count);
    for (let b = 0; b < count; b++) {
      const start = b * FANOUT;
      const end = Math.min(start + FANOUT, prevCount);
      let o = 0;
      let a = 0xffffffff;
      for (let i = start; i < end; i++) {
        o |= prevOr[i];
        a &= prevAnd[i];
      }
      or[b] = o;
      and[b] = a;
    }
    levels.push({ blockSize, or, and });
  }
  return levels;
}

interface AnalogLevel {
  readonly blockSize: number;
  readonly min: Float32Array;
  readonly max: Float32Array;
}

export interface Range {
  min: number;
  max: number;
}

/** Min/max pyramid for an analog channel. */
export class AnalogPyramid {
  readonly data: Float32Array;
  readonly length: number;
  readonly globalMin: number;
  readonly globalMax: number;
  private readonly levels: readonly AnalogLevel[];

  constructor(data: Float32Array) {
    this.data = data;
    this.length = data.length;
    this.levels = buildAnalogLevels(data);
    const top = this.levels[this.levels.length - 1];
    this.globalMin = top ? top.min[0] : 0;
    this.globalMax = top ? top.max[0] : 0;
  }

  range(start: number, end: number, out: Range): Range {
    let min = Infinity;
    let max = -Infinity;
    const d = this.data;
    const levels = this.levels;
    let i = Math.max(0, start);
    const stop = Math.min(end, this.length);
    while (i < stop) {
      let used = false;
      for (let l = levels.length - 1; l >= 0; l--) {
        const bs = levels[l].blockSize;
        if (i % bs === 0 && i + bs <= stop) {
          const blk = i / bs;
          if (levels[l].min[blk] < min) min = levels[l].min[blk];
          if (levels[l].max[blk] > max) max = levels[l].max[blk];
          i += bs;
          used = true;
          break;
        }
      }
      if (!used) {
        const v = d[i];
        if (v < min) min = v;
        if (v > max) max = v;
        i++;
      }
    }
    out.min = min;
    out.max = max;
    return out;
  }
}

function buildAnalogLevels(data: Float32Array): AnalogLevel[] {
  const n = data.length;
  const levels: AnalogLevel[] = [];
  if (n === 0) return levels;
  let blockSize = BASE_BLOCK;
  let count = Math.ceil(n / blockSize);
  let min = new Float32Array(count);
  let max = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    const start = b * blockSize;
    const end = Math.min(start + blockSize, n);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }
  levels.push({ blockSize, min, max });
  while (count > 1) {
    const pMin = min;
    const pMax = max;
    const pCount = count;
    blockSize *= FANOUT;
    count = Math.ceil(pCount / FANOUT);
    min = new Float32Array(count);
    max = new Float32Array(count);
    for (let b = 0; b < count; b++) {
      const start = b * FANOUT;
      const end = Math.min(start + FANOUT, pCount);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = start; i < end; i++) {
        if (pMin[i] < lo) lo = pMin[i];
        if (pMax[i] > hi) hi = pMax[i];
      }
      min[b] = lo;
      max[b] = hi;
    }
    levels.push({ blockSize, min, max });
  }
  return levels;
}
