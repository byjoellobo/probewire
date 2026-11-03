import { describe, expect, it } from 'vitest';
import { SerialLink } from '../serial/link';
import { FakePort } from '../sim/fakePort';
import { GusmanbFirmware, type GusmanbFirmwareOptions } from '../sim/gusmanbFirmware';
import { GusmanbDevice } from './device';
import type { GusmanbCaptureConfig } from './protocol';

/** Pin n toggles every (n + 1) samples. */
function counterSource(_rate: number, count: number): Uint32Array {
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    let w = 0;
    for (let pin = 0; pin < 24; pin++) w |= (Math.floor(i / (pin + 1)) & 1) << pin;
    out[i] = w >>> 0;
  }
  return out;
}

async function connect(opts: Partial<GusmanbFirmwareOptions> = {}): Promise<{ device: GusmanbDevice; fw: GusmanbFirmware; port: FakePort }> {
  const fw = new GusmanbFirmware({ source: counterSource, ...opts });
  const port = new FakePort(fw, { usbVendorId: 0x1209, usbProductId: 0x3020 });
  const link = await SerialLink.open(port, { dataTerminalReady: true, requestToSend: true });
  const device = await GusmanbDevice.connect(link);
  return { device, fw, port };
}

const config = (overrides: Partial<GusmanbCaptureConfig> = {}): GusmanbCaptureConfig => ({
  channels: [0, 1, 2, 3],
  sampleRate: 10_000_000,
  preSamples: 10,
  postSamples: 990,
  trigger: { type: 'edge', channel: 0, falling: false, bursts: 0, measureBursts: false },
  ...overrides,
});

describe('GusmanbDevice', () => {
  it('handshakes and reports device facts', async () => {
    const { device } = await connect();
    expect(device.info.board).toBe('PICO_2');
    expect(device.summary.title).toContain('PICO_2');
    await device.close();
  });

  it('captures 8-channel data with the trigger position', async () => {
    const { device, fw } = await connect();
    const progress: string[] = [];
    const { capture, warnings } = await device.capture(config(), { onProgress: (p) => progress.push(p.phase) });
    expect(warnings).toEqual([]);
    expect(fw.lastRequest?.captureMode).toBe(0);
    expect(capture.sampleCount).toBe(1000);
    expect(capture.samples).toBeInstanceOf(Uint8Array);
    expect(capture.triggerSample).toBe(10);
    expect(capture.channels.map((c) => c.name)).toEqual(['CH1', 'CH2', 'CH3', 'CH4']);
    const reference = counterSource(0, 1000);
    for (let i = 0; i < 1000; i++) expect(capture.samples[i]).toBe(reference[i] & 0x0f);
    expect(progress).toContain('transferring');
    await device.close();
  });

  it('remaps arbitrary channel lists to bit positions (24-channel mode)', async () => {
    const { device, fw } = await connect();
    const { capture } = await device.capture(config({ channels: [20, 3] }));
    expect(fw.lastRequest?.captureMode).toBe(2);
    expect(capture.samples).toBeInstanceOf(Uint32Array);
    const reference = counterSource(0, 1000);
    for (let i = 0; i < 1000; i++) {
      expect(capture.samples[i] & 1).toBe((reference[i] >>> 20) & 1);
      expect((capture.samples[i] >>> 1) & 1).toBe((reference[i] >>> 3) & 1);
    }
    expect(capture.channels.map((c) => c.name)).toEqual(['CH21', 'CH4']);
    await device.close();
  });

  it('collects burst boundaries and measured gaps', async () => {
    const { device } = await connect();
    const { capture } = await device.capture(
      config({ postSamples: 500, trigger: { type: 'edge', channel: 1, falling: false, bursts: 2, measureBursts: true } }),
    );
    expect(capture.sampleCount).toBe(10 + 500 * 3);
    expect(capture.burstStarts).toEqual([510, 1010]);
    expect(capture.burstGapsNs).toHaveLength(2);
    capture.burstGapsNs?.forEach((g) => expect(g).toBeCloseTo(10_000, 0));
    await device.close();
  });

  it('refuses invalid configs before touching the device', async () => {
    const { device, fw } = await connect();
    await expect(device.capture(config({ channels: [] }))).rejects.toThrow(/at least one/);
    expect(fw.lastRequest).toBeUndefined();
    await device.close();
  });

  it('reports a firmware CAPTURE_ERROR', async () => {
    const { device } = await connect({ rejectCaptures: true });
    await expect(device.capture(config())).rejects.toThrow(/rejected/);
    await device.close();
  });

  it('cancels a capture that is waiting for a trigger', async () => {
    const { device } = await connect({ triggerDelayMs: 60_000 });
    const ctrl = new AbortController();
    const run = device.capture(config(), { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(run).rejects.toThrow(/cancel/i);
    await device.close();
  }, 10_000);

  it('times out the handshake on a silent port', async () => {
    const port = new FakePort({ receive: () => undefined });
    const link = await SerialLink.open(port);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    await expect(GusmanbDevice.connect(link, ctrl.signal)).rejects.toThrow();
    await link.close();
  });
});
