/** Regression tests for issues found in code review. */
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readSr } from '../formats/srzip';
import { GusmanbDevice } from './gusmanb/device';
import { parseDeviceInfo, validateConfig, type GusmanbCaptureConfig } from './gusmanb/protocol';
import { DataLossError, LinkClosedError, SerialLink, type PortLike } from './serial/link';
import { FakePort } from './sim/fakePort';
import { GusmanbFirmware } from './sim/gusmanbFirmware';
import { PicoFirmware } from './sim/picoFirmware';
import { SigrokPicoDevice } from './sigrokPico/device';

const edge: GusmanbCaptureConfig = {
  channels: [0, 1],
  sampleRate: 1_000_000,
  preSamples: 10,
  postSamples: 100,
  trigger: { type: 'edge', channel: 0, falling: false, bursts: 0, measureBursts: false },
};

describe('gusmanb cancellation', () => {
  it('cancels an armed capture when the device is closed mid-capture', async () => {
    const fw = new GusmanbFirmware({ triggerDelayMs: 60_000, source: (_r, n) => new Uint8Array(n) });
    const link = await SerialLink.open(new FakePort(fw));
    const device = await GusmanbDevice.connect(link);
    const run = device.capture(edge).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 30));
    expect(fw.isCapturing).toBe(true);
    await device.close();
    expect(fw.isCapturing).toBe(false);
    expect(await run).toBeInstanceOf(Error);
  });
});

describe('config validation', () => {
  const info = parseDeviceInfo(['LOGIC_ANALYZER_PICO_V6_0', 'FREQ:100000000', 'BLASTFREQ:200000000', 'BUFFER:131072', 'CHANNELS:24']);

  it('rejects NaN and fractional values', () => {
    expect(validateConfig({ ...edge, sampleRate: Number.NaN }, info).join()).toMatch(/whole number/);
    expect(validateConfig({ ...edge, postSamples: 10.5 }, info).join()).toMatch(/whole number/);
  });

  it('accepts the external trigger but not a channel one past the last', () => {
    expect(validateConfig({ ...edge, trigger: { ...edge.trigger, channel: 24 } as GusmanbCaptureConfig['trigger'] }, info)).toEqual([]);
    const small = { ...info, channelCount: 16 };
    expect(validateConfig({ ...edge, trigger: { ...edge.trigger, channel: 16 } as GusmanbCaptureConfig['trigger'] }, small).join()).toMatch(
      /Trigger channel/,
    );
  });
});

describe('sigrok-pico analog-only capture', () => {
  it('builds a capture with analog data and no logic channels', async () => {
    const fw = new PicoFirmware({
      source: ({ count }) => ({ digital: new Uint32Array(count), analog: [Array.from({ length: count }, (_, i) => i % 128)] }),
    });
    const device = await SigrokPicoDevice.connect(await SerialLink.open(new FakePort(fw)));
    const { capture } = await device.capture({ digitalChannels: 0, analogChannels: [0], sampleRate: 100_000, sampleCount: 300 });
    expect(capture.channels).toEqual([]);
    expect(capture.sampleCount).toBe(300);
    expect(capture.analog[0].data[3]).toBeCloseTo(3 * 0.0257, 5);
    await device.close();
  });
});

/** A port whose first stream fails with the given error after sending some bytes. */
function flakyPort(errorName: string, freshStreamAfter: boolean): PortLike {
  let streams = 0;
  let readable: ReadableStream<Uint8Array> | null = null;
  const port: PortLike = {
    get readable() {
      return readable;
    },
    writable: new WritableStream<Uint8Array>(),
    async open() {
      readable = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2]));
          const err = new Error('boom');
          err.name = errorName;
          setTimeout(() => {
            c.error(err);
            streams++;
            readable = freshStreamAfter
              ? new ReadableStream<Uint8Array>({
                  start(c2) {
                    setTimeout(() => c2.enqueue(new Uint8Array([3, 4, 5, 6])), 5);
                  },
                })
              : null;
          }, 5);
        },
      });
    },
    async close() {
      readable = null;
    },
  };
  void streams;
  return port;
}

describe('SerialLink error handling', () => {
  it('fails a binary read when bytes were lost to an overrun, then keeps working', async () => {
    const link = await SerialLink.open(flakyPort('BufferOverrunError', true));
    await expect(link.readExact(6, { timeoutMs: 500 })).rejects.toBeInstanceOf(DataLossError);
    expect(link.lossCount).toBe(1);
    // Bytes that arrived after the overrun are still delivered in order.
    expect(Array.from(await link.readExact(2, { timeoutMs: 500 }))).toEqual([3, 4]);
    await link.close();
  });

  it('reports an unplug as LinkClosedError', async () => {
    const link = await SerialLink.open(flakyPort('NetworkError', false));
    await link.readExact(2, { timeoutMs: 500 });
    await expect(link.readExact(1, { timeoutMs: 500 })).rejects.toBeInstanceOf(LinkClosedError);
    expect(link.isClosed).toBe(true);
    await link.close();
  });

  it('closes the port if the link cannot be built', async () => {
    let closed = false;
    const port: PortLike = {
      readable: null,
      writable: null,
      async open() {},
      async close() {
        closed = true;
      },
    };
    await expect(SerialLink.open(port)).rejects.toBeInstanceOf(LinkClosedError);
    expect(closed).toBe(true);
  });
});

describe('untrusted .sr files', () => {
  const metadata = (extra: string): Uint8Array =>
    strToU8(`[device 1]\ncapturefile=logic-1\ntotal probes=1\nsamplerate=1 kHz\nprobe1=A\nunitsize=1\n${extra}`);

  it('never inflates entries that are not part of a session', async () => {
    const bytes = zipSync({
      version: strToU8('2'),
      metadata: metadata(''),
      'logic-1-1': new Uint8Array([1, 0, 1]),
      'junk.bin': new Uint8Array(1000),
    });
    const { capture } = await readSr(bytes);
    expect(capture.sampleCount).toBe(3);
  });

  it('does not resolve file names through the object prototype', async () => {
    const bytes = zipSync({
      version: strToU8('2'),
      metadata: strToU8('[device 1]\ncapturefile=constructor\ntotal probes=1\nunitsize=1\nprobe1=A\n'),
    });
    await expect(readSr(bytes)).rejects.toThrow(/missing/);
  });

  it('replaces non-finite analog values and warns', async () => {
    const floats = new Float32Array([1, Number.POSITIVE_INFINITY, Number.NaN, 2]);
    const bytes = zipSync({
      version: strToU8('2'),
      metadata: strToU8('[device 1]\nsamplerate=1 kHz\ntotal analog=1\nanalog1=V\n'),
      'analog-1-1-1': new Uint8Array(floats.buffer),
    });
    const { capture, warnings } = await readSr(bytes);
    expect(Array.from(capture.analog[0].data)).toEqual([1, 0, 0, 2]);
    expect(warnings.join()).toMatch(/2 invalid values/);
  });
});
