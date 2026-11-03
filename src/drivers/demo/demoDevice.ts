/**
 * Built-in signal generator "device" and simulated-hardware connectors.
 *
 * - DemoDevice synthesises a large capture directly (millions of samples), so
 *   the viewer and decoders can be tried without hardware.
 * - connectSimulated() runs the real gusmanb / sigrok-pico drivers against the
 *   firmware models in ../sim over an in-memory port, which exercises the
 *   full protocol path in the browser.
 */
import { createCapture } from '../../core/capture';
import { GusmanbDevice } from '../gusmanb/device';
import { SerialLink } from '../serial/link';
import { FakePort } from '../sim/fakePort';
import { GusmanbFirmware } from '../sim/gusmanbFirmware';
import { PicoFirmware } from '../sim/picoFirmware';
import { SigrokPicoDevice } from '../sigrokPico/device';
import { formatHz, type CaptureDevice, type CaptureOutcome, type CaptureRunOptions, type DeviceSummary } from '../types';
import { DEMO_CHANNEL_COUNT, DEMO_CHANNEL_NAMES, analogScenario, buildScenario } from './scenario';

export interface DemoCaptureConfig {
  readonly sampleRate: number;
  readonly sampleCount: number;
}

export const DEMO_MAX_SAMPLES = 50_000_000;

export class DemoDevice implements CaptureDevice<DemoCaptureConfig> {
  readonly summary: DeviceSummary = {
    kind: 'demo',
    title: 'Signal generator (demo)',
    facts: [
      ['Channels', `${DEMO_CHANNEL_COUNT} (UART, I2C, SPI, PWM, clock)`],
      ['Max samples', DEMO_MAX_SAMPLES.toLocaleString('en-US')],
    ],
  };

  async capture(config: DemoCaptureConfig, options: CaptureRunOptions = {}): Promise<CaptureOutcome> {
    if (!Number.isInteger(config.sampleCount) || config.sampleCount < 1000 || config.sampleCount > DEMO_MAX_SAMPLES) {
      throw new Error(`Sample count must be 1,000 to ${DEMO_MAX_SAMPLES.toLocaleString('en-US')}.`);
    }
    if (config.sampleRate < 10_000 || config.sampleRate > 500_000_000) throw new Error('Sample rate must be 10 kHz to 500 MHz.');
    options.onProgress?.({ phase: 'processing', message: 'Generating signals' });
    // Yield so the progress message paints before the synchronous build.
    await new Promise((r) => setTimeout(r, 0));
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const samples = buildScenario({ sampleRate: config.sampleRate, sampleCount: config.sampleCount });
    const capture = createCapture({
      sampleRate: config.sampleRate,
      channels: DEMO_CHANNEL_NAMES.map((name, index) => ({ index, name })),
      samples,
      source: `Demo generator at ${formatHz(config.sampleRate)}`,
    });
    const warnings = config.sampleRate < 4_000_000 ? ['Below 4 MHz some protocol traffic is left out of the demo.'] : [];
    return { capture, warnings };
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

export type SimulatedKind = 'gusmanb' | 'sigrok-pico';

/** Connects the real driver to a simulated device. */
export async function connectSimulated(kind: 'gusmanb'): Promise<GusmanbDevice>;
export async function connectSimulated(kind: 'sigrok-pico'): Promise<SigrokPicoDevice>;
export async function connectSimulated(kind: SimulatedKind): Promise<GusmanbDevice | SigrokPicoDevice> {
  if (kind === 'gusmanb') {
    const fw = new GusmanbFirmware({
      triggerDelayMs: 300,
      chunkSize: 4096,
      source: (sampleRate, count) => buildScenario({ sampleRate, sampleCount: count, channelCount: 24 }),
    });
    const link = await SerialLink.open(new FakePort(fw, { usbVendorId: 0x1209, usbProductId: 0x3020 }));
    return GusmanbDevice.connect(link);
  }
  const fw = new PicoFirmware({
    chunkSize: 4096,
    source: ({ analogChannels, rate, count }) => ({
      digital: buildScenario({ sampleRate: rate, sampleCount: count, channelCount: 32 }),
      analog: analogChannels.map((ch) => analogScenario(ch, count, rate)),
    }),
  });
  const link = await SerialLink.open(new FakePort(fw, { usbVendorId: 0x2e8a, usbProductId: 0x000a }));
  return SigrokPicoDevice.connect(link);
}
