import { describe, expect, it } from 'vitest';
import { encodeStream } from '../sim/picoFirmware';
import {
  PicoStreamDecoder,
  deviceSampleLimit,
  digitalChannelName,
  effectiveSampleRate,
  parseAnalogScale,
  parseIdentify,
  usesD4Mode,
  validatePicoConfig,
  type PicoCaptureConfig,
} from './protocol';

const ID = parseIdentify('SRPICO,A031D21,02');

function randomRuns(count: number, bits: number, seed = 1): Uint32Array {
  let s = seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out = new Uint32Array(count);
  let v = 0;
  for (let i = 0; i < count; i++) {
    if (rnd() < 0.05) v = Math.floor(rnd() * 2 ** bits) >>> 0;
    out[i] = v;
  }
  return out;
}

function decodeAll(stream: Uint8Array, opts: ConstructorParameters<typeof PicoStreamDecoder>[0], chunk = 7): PicoStreamDecoder {
  const dec = new PicoStreamDecoder(opts);
  for (let i = 0; i < stream.length; i += chunk) dec.push(stream.subarray(i, i + chunk));
  return dec;
}

describe('identify and settings', () => {
  it('parses the identify reply', () => {
    expect(ID).toMatchObject({ analogCount: 3, analogBytes: 1, digitalCount: 21, version: 2 });
    expect(() => parseIdentify('SRPICO,A031D21,00')).toThrow(/version/);
    expect(() => parseIdentify('hello')).toThrow();
  });

  it('parses analog scales and falls back to the default', () => {
    expect(parseAnalogScale('25700x0')).toEqual({ scale: 0.0257, offset: 0 });
    expect(parseAnalogScale('1000x-500')).toEqual({ scale: 0.001, offset: -0.0005 });
    expect(parseAnalogScale('???').scale).toBeCloseTo(0.0257);
  });

  it('names channels per firmware build', () => {
    expect(digitalChannelName(0, 21)).toBe('GP2');
    expect(digitalChannelName(23, 26)).toBe('GP26');
    expect(digitalChannelName(5, 32)).toBe('GP5');
  });

  it('applies the device rate rules', () => {
    const base: PicoCaptureConfig = { digitalChannels: 8, analogChannels: [], sampleRate: 1_000_001, sampleCount: 1000 };
    expect(effectiveSampleRate(base)).toBe(1_000_000);
    expect(effectiveSampleRate({ ...base, sampleRate: 100 })).toBe(5000);
    // Mixed mode needs a divisor of 24 MHz.
    expect(effectiveSampleRate({ ...base, analogChannels: [0], sampleRate: 70_000 })).toBe(69_970);
    expect(deviceSampleLimit(1)).toBe(16);
    expect(deviceSampleLimit(17)).toBe(24);
    expect(usesD4Mode(base)).toBe(false);
    expect(usesD4Mode({ ...base, digitalChannels: 4 })).toBe(true);
  });

  it('validates configs', () => {
    const ok: PicoCaptureConfig = { digitalChannels: 8, analogChannels: [0], sampleRate: 100_000, sampleCount: 1000 };
    expect(validatePicoConfig(ok, ID)).toEqual([]);
    expect(validatePicoConfig({ ...ok, analogChannels: [0, 1, 2], sampleRate: 200_000 }, ID).join()).toMatch(/at most/);
    expect(validatePicoConfig({ ...ok, digitalChannels: 22 }, ID).join()).toMatch(/0 to 21/);
    expect(validatePicoConfig({ ...ok, digitalChannels: 0, analogChannels: [] }, ID).join()).toMatch(/at least one/);
  });
});

describe('stream decoder', () => {
  it('round-trips D4 mode with long runs', () => {
    const count = 5000;
    const digital = randomRuns(count, 4, 7);
    const stream = encodeStream({ digital, analog: [] }, 4, 0, count);
    const trailer = new TextEncoder().encode(`$${stream.length}+\n`);
    const dec = decodeAll(new Uint8Array([...stream, ...trailer]), {
      digitalChannels: 4,
      analogScales: [],
      analogBytes: 1,
      limit: count,
      d4: true,
    });
    expect(dec.status).toBe('done');
    expect(dec.trailerByteCount).toBe(dec.receivedDataBytes);
    expect(Array.from(dec.result().digital)).toEqual(Array.from(digital));
  });

  it('masks unused D4 bits', () => {
    const digital = Uint32Array.from([0xf, 0xe, 0x3]);
    const stream = encodeStream({ digital, analog: [] }, 2, 0, 3);
    const dec = decodeAll(stream, { digitalChannels: 2, analogScales: [], analogBytes: 1, limit: 3, d4: true });
    expect(Array.from(dec.result().digital)).toEqual([3, 2, 3]);
  });

  it.each([5, 8, 14, 21, 32])('round-trips general mode with %i channels and run-length bytes', (channels) => {
    const count = 20_000;
    const digital = randomRuns(count, Math.min(channels, 31), channels);
    const stream = encodeStream({ digital, analog: [] }, channels, 0, count);
    const dec = decodeAll(new Uint8Array([...stream, ...new TextEncoder().encode(`$${stream.length}+`)]), {
      digitalChannels: channels,
      analogScales: [],
      analogBytes: 1,
      limit: count,
      d4: false,
    });
    expect(dec.status).toBe('done');
    expect(dec.sampleCount).toBe(count);
    expect(Array.from(dec.result().digital)).toEqual(Array.from(digital));
  });

  it('decodes analog channels with scaling, interleaved with digital', () => {
    const count = 300;
    const digital = randomRuns(count, 8, 3);
    const a0 = Array.from({ length: count }, (_, i) => i % 128);
    const a2 = Array.from({ length: count }, (_, i) => 127 - (i % 128));
    const stream = encodeStream({ digital, analog: [a0, a2] }, 8, 2, count);
    const scale = { scale: 0.0257, offset: 0 };
    const dec = decodeAll(stream, { digitalChannels: 8, analogScales: [scale, scale], analogBytes: 1, limit: count, d4: false }, 5);
    const { digital: d, analog } = dec.result();
    expect(Array.from(d)).toEqual(Array.from(digital));
    expect(analog[0][10]).toBeCloseTo(10 * 0.0257, 5);
    expect(analog[1][10]).toBeCloseTo(117 * 0.0257, 5);
  });

  it('handles a trailer that starts at the very end of a chunk', () => {
    const digital = randomRuns(64, 8, 9);
    const stream = encodeStream({ digital, analog: [] }, 8, 0, 64);
    const dec = new PicoStreamDecoder({ digitalChannels: 8, analogScales: [], analogBytes: 1, limit: 64, d4: false });
    dec.push(new Uint8Array([...stream, 0x24]));
    expect(dec.status).toBe('trailer');
    dec.push(new TextEncoder().encode(`${stream.length}+\n`));
    expect(dec.status).toBe('done');
  });

  it('reports device aborts', () => {
    const dec = new PicoStreamDecoder({ digitalChannels: 7, analogScales: [], analogBytes: 1, limit: 64, d4: false });
    dec.push(new Uint8Array([0x81, 0x41]));
    dec.push(new TextEncoder().encode('!!!$0+'));
    expect(dec.status).toBe('aborted');
    expect(dec.sampleCount).toBe(1 + 18);
  });

  it('truncates extra samples beyond the limit', () => {
    const digital = randomRuns(100, 8, 4);
    const stream = encodeStream({ digital, analog: [] }, 8, 0, 100);
    const dec = decodeAll(stream, { digitalChannels: 8, analogScales: [], analogBytes: 1, limit: 40, d4: false });
    expect(dec.sampleCount).toBe(40);
    expect(Array.from(dec.result().digital)).toEqual(Array.from(digital.subarray(0, 40)));
  });
});
