import { describe, expect, it } from 'vitest';
import {
  buildFrame,
  burstGapsNs,
  captureModeFor,
  decodeCaptureRequest,
  decodeSamples,
  encodeCaptureRequest,
  limitsFor,
  parseDeviceInfo,
  parseFrame,
  patternTriggerOffset,
  requestFields,
  stampToTicks,
  validateConfig,
  type GusmanbCaptureConfig,
  type GusmanbDeviceInfo,
} from './protocol';

const INFO: GusmanbDeviceInfo = parseDeviceInfo([
  'LOGIC_ANALYZER_PICO_2_V6_0',
  'FREQ:100000000',
  'BLASTFREQ:200000000',
  'BUFFER:393216',
  'CHANNELS:24',
]);

const edge = (overrides: Partial<GusmanbCaptureConfig> = {}): GusmanbCaptureConfig => ({
  channels: [0, 1, 2, 3],
  sampleRate: 1_000_000,
  preSamples: 100,
  postSamples: 1000,
  trigger: { type: 'edge', channel: 0, falling: false, bursts: 0, measureBursts: false },
  ...overrides,
});

describe('framing', () => {
  it('wraps the device-info command', () => {
    expect(Array.from(buildFrame(0))).toEqual([0x55, 0xaa, 0x00, 0xaa, 0x55]);
  });

  it('escapes AA, 55 and F0 inside the payload', () => {
    const frame = buildFrame(1, new Uint8Array([0xaa, 0x55, 0xf0, 0x12]));
    expect(Array.from(frame)).toEqual([0x55, 0xaa, 0x01, 0xf0, 0x5a, 0xf0, 0xa5, 0xf0, 0x00, 0x12, 0xaa, 0x55]);
    expect(Array.from(parseFrame(frame) ?? [])).toEqual([0x01, 0xaa, 0x55, 0xf0, 0x12]);
  });

  it('rejects frames that would overflow the device buffer', () => {
    expect(() => buildFrame(2, new Uint8Array(130))).toThrow(RangeError);
  });

  it('parseFrame rejects malformed input', () => {
    expect(parseFrame(new Uint8Array([1, 2, 3, 4, 5]))).toBeUndefined();
    expect(parseFrame(new Uint8Array([0x55, 0xaa, 0xf0, 0xaa, 0x55]))).toBeUndefined();
  });
});

describe('device info', () => {
  it('parses the handshake', () => {
    expect(INFO).toMatchObject({
      board: 'PICO_2',
      major: 6,
      minor: 0,
      maxFrequency: 100_000_000,
      blastFrequency: 200_000_000,
      bufferBytes: 393216,
      channelCount: 24,
      turbo: false,
    });
  });

  it('detects turbo builds by max frequency', () => {
    const info = parseDeviceInfo(['LOGIC_ANALYZER_PICO_V6_0', 'FREQ:200000000', 'BLASTFREQ:400000000', 'BUFFER:131072', 'CHANNELS:24']);
    expect(info.turbo).toBe(true);
    expect(info.board).toBe('PICO');
  });

  it('rejects old firmware and malformed lines', () => {
    expect(() => parseDeviceInfo(['LOGIC_ANALYZER_V5_2', 'FREQ:1', 'BLASTFREQ:1', 'BUFFER:1', 'CHANNELS:1'])).toThrow(/too old/);
    expect(() => parseDeviceInfo(['LOGIC_ANALYZER_PICO_V6_0', 'FREQ:x', 'BLASTFREQ:1', 'BUFFER:1', 'CHANNELS:1'])).toThrow(/FREQ/);
    expect(() => parseDeviceInfo(['hello'])).toThrow();
  });
});

describe('capture request', () => {
  it('lays out the 48-byte struct with natural alignment', () => {
    const fields = requestFields(edge({ channels: [0, 5, 9], trigger: { type: 'edge', channel: 5, falling: true, bursts: 3, measureBursts: true } }), INFO);
    const buf = encodeCaptureRequest(fields);
    const v = new DataView(buf.buffer);
    expect(buf.length).toBe(48);
    expect(buf[0]).toBe(0); // edge
    expect(buf[1]).toBe(5);
    expect(buf[2]).toBe(1); // falling = inverted
    expect(Array.from(buf.subarray(6, 9))).toEqual([0, 5, 9]);
    expect(buf[30]).toBe(3);
    expect(v.getUint32(32, true)).toBe(1_000_000);
    expect(v.getUint32(36, true)).toBe(100);
    expect(v.getUint32(40, true)).toBe(1000);
    expect(buf[44]).toBe(3);
    expect(buf[45]).toBe(1);
    expect(buf[46]).toBe(1); // channel 9 -> 16-channel mode
    expect(decodeCaptureRequest(buf)).toEqual(fields);
  });

  it('picks the capture mode from the highest channel number', () => {
    expect(captureModeFor([0, 7])).toBe(0);
    expect(captureModeFor([8])).toBe(1);
    expect(captureModeFor([3, 16])).toBe(2);
  });

  it('compensates pattern-trigger latency', () => {
    const offset = patternTriggerOffset('complex', 100_000_000, 100_000_000);
    expect(offset).toBe(5);
    const fields = requestFields(
      edge({ sampleRate: 100_000_000, trigger: { type: 'complex', baseChannel: 0, bitCount: 3, pattern: 0b101 } }),
      INFO,
    );
    expect(fields).toMatchObject({ triggerType: 1, invertedOrCount: 3, triggerValue: 5, preSamples: 105, postSamples: 995 });
    expect(patternTriggerOffset('fast', 1_000_000, 100_000_000)).toBe(0);
  });

  it('forces blast settings', () => {
    const fields = requestFields(
      edge({ sampleRate: 200_000_000, preSamples: 50, trigger: { type: 'blast', channel: 2, falling: false } }),
      INFO,
    );
    expect(fields).toMatchObject({ triggerType: 3, preSamples: 0, loopCount: 0, measure: false });
  });
});

describe('validation', () => {
  it('accepts a sane config', () => {
    expect(validateConfig(edge(), INFO)).toEqual([]);
  });

  it('flags bad channels, rates and sample counts', () => {
    expect(validateConfig(edge({ channels: [] }), INFO).join()).toMatch(/at least one/);
    expect(validateConfig(edge({ channels: [24] }), INFO).join()).toMatch(/0 to 23/);
    expect(validateConfig(edge({ channels: [1, 1] }), INFO).join()).toMatch(/once/);
    expect(validateConfig(edge({ sampleRate: 1000 }), INFO).join()).toMatch(/Sample rate/);
    expect(validateConfig(edge({ preSamples: 1 }), INFO).join()).toMatch(/Pre-trigger/);
    expect(validateConfig(edge({ postSamples: 400_000 }), INFO).join()).toMatch(/Post-trigger/);
  });

  it('checks burst totals against the buffer', () => {
    const limits = limitsFor(INFO, 0);
    expect(limits.totalSamples).toBe(393216);
    expect(limits.maxPre).toBe(39321);
    expect(limits.minFrequency).toBe(3051);
    const tooMany = edge({ postSamples: 100_000, trigger: { type: 'edge', channel: 0, falling: false, bursts: 3, measureBursts: false } });
    expect(validateConfig(tooMany, INFO).join()).toMatch(/fit/);
  });

  it('enforces blast and pattern rules', () => {
    expect(validateConfig(edge({ trigger: { type: 'blast', channel: 0, falling: false } }), INFO).join()).toMatch(/Blast/);
    expect(validateConfig(edge({ trigger: { type: 'fast', baseChannel: 2, bitCount: 4, pattern: 1 } }), INFO).join()).toMatch(/pattern/);
    expect(validateConfig(edge({ trigger: { type: 'complex', baseChannel: 0, bitCount: 17, pattern: 1 } }), INFO).join()).toMatch(/1 to 16/);
  });
});

describe('sample data', () => {
  it('decodes 8, 16 and 24 channel modes', () => {
    expect(Array.from(decodeSamples(new Uint8Array([1, 2, 3]), 0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(decodeSamples(new Uint8Array([0x34, 0x12, 0x78, 0x56]), 1, 2))).toEqual([0x1234, 0x5678]);
    expect(Array.from(decodeSamples(new Uint8Array([0x01, 0x02, 0x03, 0xff]), 2, 1))).toEqual([0x030201]);
  });

  it('converts SysTick stamps and burst gaps', () => {
    expect(stampToTicks(0x00ffffff)).toBe(0);
    expect(stampToTicks(0x01ffffff)).toBe(0x01000000);
    const stamp = (elapsed: number): number => (((elapsed >>> 24) << 24) | (0xffffff - (elapsed & 0xffffff))) >>> 0;
    // 1000 samples at 1 MHz = 1 ms = 200000 ticks; plus 2000 ticks (10 us) of dead time.
    const stamps = [stamp(0), stamp(200_000), stamp(402_000), stamp(604_000)];
    const gaps = burstGapsNs(stamps, 1_000_000, 1000, 200_000_000);
    expect(gaps).toHaveLength(2);
    gaps.forEach((g) => expect(g).toBeCloseTo(10_000, 3));
  });
});
