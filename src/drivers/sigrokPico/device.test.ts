import { describe, expect, it } from 'vitest';
import { SerialLink } from '../serial/link';
import { FakePort } from '../sim/fakePort';
import { PicoFirmware, type PicoFirmwareOptions } from '../sim/picoFirmware';
import { SigrokPicoDevice } from './device';

function source({ count }: { count: number }): { digital: Uint32Array; analog: number[][] } {
  const digital = new Uint32Array(count);
  for (let i = 0; i < count; i++) digital[i] = (Math.floor(i / 3) * 0x9e3779b1) >>> 11;
  const ramp = Array.from({ length: count }, (_, i) => i % 128);
  return { digital, analog: [ramp, ramp, ramp] };
}

async function connect(opts: Partial<PicoFirmwareOptions> = {}): Promise<{ device: SigrokPicoDevice; fw: PicoFirmware }> {
  const fw = new PicoFirmware({ source, ...opts });
  const port = new FakePort(fw, { usbVendorId: 0x2e8a, usbProductId: 0x000a });
  const link = await SerialLink.open(port);
  const device = await SigrokPicoDevice.connect(link);
  return { device, fw };
}

describe('SigrokPicoDevice', () => {
  it('identifies the firmware and reads analog scales', async () => {
    const { device } = await connect();
    expect(device.identity).toMatchObject({ analogCount: 3, digitalCount: 21 });
    expect(device.analogScales).toHaveLength(3);
    expect(device.analogScales[0].scale).toBeCloseTo(0.0257);
    await device.close();
  });

  it('configures channels in order and captures digital data', async () => {
    const { device, fw } = await connect();
    const { capture, warnings } = await device.capture({ digitalChannels: 8, analogChannels: [], sampleRate: 1_000_000, sampleCount: 1000 });
    expect(warnings).toEqual([]);
    expect(fw.commands).toContain('D17');
    expect(fw.commands).toContain('D08');
    expect(fw.commands).toContain('L1000');
    expect(fw.commands).toContain('R1000000');
    expect(fw.commands[fw.commands.length - 1]).toBe('F');
    const ref = source({ count: 1000 }).digital;
    expect(capture.sampleCount).toBe(1000);
    for (let i = 0; i < 1000; i++) expect(capture.samples[i]).toBe(ref[i] & 0xff);
    expect(capture.channels[0].name).toBe('GP2');
    await device.close();
  });

  it('captures in D4 mode', async () => {
    const { device } = await connect();
    const { capture } = await device.capture({ digitalChannels: 3, analogChannels: [], sampleRate: 2_000_000, sampleCount: 500 });
    const ref = source({ count: 504 }).digital;
    for (let i = 0; i < 500; i++) expect(capture.samples[i]).toBe(ref[i] & 0x7);
    await device.close();
  });

  it('captures mixed analog and digital, adjusting the rate', async () => {
    const { device } = await connect();
    const { capture, warnings } = await device.capture({ digitalChannels: 4, analogChannels: [1], sampleRate: 70_000, sampleCount: 200 });
    expect(capture.sampleRate).toBe(Math.floor(24_000_000 / 343) - (Math.floor(24_000_000 / 343) % 2));
    expect(warnings.join()).toMatch(/nearest supported rate/);
    expect(capture.analog).toHaveLength(1);
    expect(capture.analog[0].name).toBe('ADC1');
    expect(capture.analog[0].data[5]).toBeCloseTo(5 * 0.0257, 5);
    await device.close();
  });

  it('turns a device abort into an error', async () => {
    const { device } = await connect({ abortAfterBytes: 0.5 });
    await expect(device.capture({ digitalChannels: 8, analogChannels: [], sampleRate: 1_000_000, sampleCount: 1000 })).rejects.toThrow(/aborted/);
    await device.close();
  });

  it('warns about data loss reported by the trailer', async () => {
    const { device } = await connect({ dropBytes: 3 });
    const { warnings } = await device.capture({ digitalChannels: 8, analogChannels: [], sampleRate: 1_000_000, sampleCount: 1000 });
    expect(warnings.join()).toMatch(/Data loss/);
    await device.close();
  });
});
