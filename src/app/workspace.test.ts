import { describe, expect, it } from 'vitest';
import { createCapture } from '../core/capture';
import { getDecoder } from '../decoders/registry';
import { DEMO_CHANNEL_NAMES } from '../drivers/demo/scenario';
import { autoAssign, buildWorkspace, newDecoderInstance, reconcileChannels, runDecoder } from './workspace';

const demo = createCapture({
  sampleRate: 1e6,
  channels: DEMO_CHANNEL_NAMES.map((name, index) => ({ index, name })),
  samples: new Uint16Array(100),
  source: 't',
});

describe('autoAssign', () => {
  it('maps demo channel names to decoder inputs', () => {
    expect(autoAssign(getDecoder('uart')!, demo)).toEqual({ tx: 0, rx: 1 });
    expect(autoAssign(getDecoder('i2c')!, demo)).toEqual({ scl: 2, sda: 3 });
    expect(autoAssign(getDecoder('spi')!, demo)).toEqual({ clk: 5, mosi: 6, miso: 7, cs: 4 });
  });

  it('falls back to channels in order when names give no hints', () => {
    const plain = createCapture({ sampleRate: 1e6, channels: [0, 1, 2, 3].map((i) => ({ index: i, name: `D${i}` })), samples: new Uint8Array(4), source: 't' });
    expect(autoAssign(getDecoder('i2c')!, plain)).toEqual({ scl: 0, sda: 1 });
    expect(Object.values(autoAssign(getDecoder('spi')!, plain))).toEqual([0, 1, 2, 3]);
  });
});

describe('decoder instances', () => {
  it('hides bit rows by default and reports missing channels', () => {
    const inst = newDecoderInstance('i2c', undefined);
    expect(inst.hiddenRows).toEqual(['bits']);
    const res = runDecoder(inst, buildWorkspace(demo));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/SCL/);
  });

  it('drops assignments to channels that no longer exist', () => {
    const inst = { ...newDecoderInstance('uart', demo), channels: { tx: 0, rx: 40 } };
    expect(reconcileChannels(inst, demo).channels).toEqual({ tx: 0, rx: undefined });
  });
});
