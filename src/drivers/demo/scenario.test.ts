import { describe, expect, it } from 'vitest';
import { LogicPyramid } from '../../core/pyramid';
import { i2cDecoder } from '../../decoders/i2c';
import { spiDecoder } from '../../decoders/spi';
import { uartDecoder } from '../../decoders/uart';
import { DemoDevice, connectSimulated } from './demoDevice';
import { buildScenario } from './scenario';

describe('demo scenario', () => {
  const rate = 10_000_000;
  const samples = buildScenario({ sampleRate: rate, sampleCount: 100_000 });
  const input = { pyramid: new LogicPyramid(samples), sampleRate: rate };

  it('decodes as UART text', () => {
    const out = uartDecoder.decode(input, { tx: 0, rx: 1 }, { baud: 115200, format: 'ascii' });
    // UART rows: 0 RX, 1 RX bits, 2 TX, 3 TX bits.
    const tx = out.annotations.filter((a) => a.row === 2 && a.kind === 'data').map((a) => a.value ?? 0);
    expect(String.fromCharCode(...tx)).toContain('Hello from Probewire #0');
    expect(out.annotations.some((a) => a.kind === 'error')).toBe(false);
  });

  it('decodes as I2C with the EEPROM address', () => {
    const out = i2cDecoder.decode(input, { scl: 2, sda: 3 }, {});
    expect(out.annotations.some((a) => a.kind === 'address' && a.value === 0x50)).toBe(true);
  });

  it('decodes as SPI with the JEDEC ID reply', () => {
    const out = spiDecoder.decode(input, { cs: 4, clk: 5, mosi: 6, miso: 7 }, {});
    const miso = out.annotations.filter((a) => a.row === 1 && a.kind === 'data').map((a) => a.value);
    expect(miso.slice(0, 4)).toEqual([0xff, 0xef, 0x40, 0x18]);
  });
});

describe('demo devices', () => {
  it('generates a multi-million-sample capture', async () => {
    const { capture } = await new DemoDevice().capture({ sampleRate: 20_000_000, sampleCount: 4_000_000 });
    expect(capture.sampleCount).toBe(4_000_000);
    expect(capture.channels).toHaveLength(10);
  });

  it('runs the real gusmanb driver against the simulator', async () => {
    const device = await connectSimulated('gusmanb');
    const { capture } = await device.capture({
      channels: [0, 1, 2, 3],
      sampleRate: 10_000_000,
      preSamples: 100,
      postSamples: 20_000,
      trigger: { type: 'edge', channel: 0, falling: true, bursts: 0, measureBursts: false },
    });
    expect(capture.sampleCount).toBe(20_100);
    await device.close();
  });

  it('runs the real sigrok-pico driver against the simulator', async () => {
    const device = await connectSimulated('sigrok-pico');
    const { capture } = await device.capture({ digitalChannels: 10, analogChannels: [0], sampleRate: 100_000, sampleCount: 2000 });
    expect(capture.sampleCount).toBe(2000);
    expect(capture.analog).toHaveLength(1);
    await device.close();
  });
});
