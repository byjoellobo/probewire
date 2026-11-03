/** Connecting to analyzers: real hardware over Web Serial/WebUSB, or built-in simulators. */
import { DemoDevice, connectSimulated, type DemoCaptureConfig } from '../drivers/demo/demoDevice';
import { GusmanbDevice } from '../drivers/gusmanb/device';
import { GUSMANB_USB_FILTER, type GusmanbCaptureConfig } from '../drivers/gusmanb/protocol';
import { SerialLink, type PortLike } from '../drivers/serial/link';
import { bufferSizeFor, requestPort, type PortFilter, type SerialBackend } from '../drivers/serial/ports';
import { SigrokPicoDevice } from '../drivers/sigrokPico/device';
import { SIGROK_PICO_USB_FILTER, type PicoCaptureConfig } from '../drivers/sigrokPico/protocol';

export type DeviceChoice = 'gusmanb' | 'sigrok-pico' | 'demo' | 'sim-gusmanb' | 'sim-sigrok-pico';

export const DEVICE_CHOICES: ReadonlyArray<{ readonly id: DeviceChoice; readonly label: string; readonly hardware: boolean }> = [
  { id: 'gusmanb', label: 'gusmanb Logic Analyzer (Pico)', hardware: true },
  { id: 'sigrok-pico', label: 'sigrok-pico (Pico)', hardware: true },
  { id: 'demo', label: 'Signal generator (no hardware)', hardware: false },
  { id: 'sim-gusmanb', label: 'Simulated gusmanb analyzer', hardware: false },
  { id: 'sim-sigrok-pico', label: 'Simulated sigrok-pico', hardware: false },
];

export type Connected =
  | { readonly kind: 'gusmanb'; readonly device: GusmanbDevice; readonly simulated: boolean; readonly port?: PortLike }
  | { readonly kind: 'sigrok-pico'; readonly device: SigrokPicoDevice; readonly simulated: boolean; readonly port?: PortLike }
  | { readonly kind: 'demo'; readonly device: DemoDevice };

export interface CaptureConfigs {
  readonly gusmanb: GusmanbCaptureConfig;
  readonly pico: PicoCaptureConfig;
  readonly demo: DemoCaptureConfig;
}

export const DEFAULT_CONFIGS: CaptureConfigs = {
  gusmanb: {
    channels: [0, 1, 2, 3, 4, 5, 6, 7],
    sampleRate: 10_000_000,
    preSamples: 512,
    postSamples: 60_000,
    trigger: { type: 'edge', channel: 0, falling: true, bursts: 0, measureBursts: false },
  },
  pico: { digitalChannels: 8, analogChannels: [], sampleRate: 1_000_000, sampleCount: 200_000 },
  demo: { sampleRate: 10_000_000, sampleCount: 5_000_000 },
};

export interface ConnectOptions {
  readonly backend: SerialBackend;
  /** Offer every serial port instead of filtering by USB ID. */
  readonly anyPort: boolean;
  readonly signal?: AbortSignal;
}

/** Thrown when the user closes the port picker without choosing. */
export class PickerCancelled extends Error {
  constructor() {
    super('No port was selected.');
    this.name = 'PickerCancelled';
  }
}

async function openPort(
  filter: PortFilter,
  opts: ConnectOptions,
  signals: { dtr: boolean; rts: boolean },
): Promise<{ link: SerialLink; port: PortLike }> {
  let port;
  try {
    port = await requestPort(opts.backend, opts.anyPort ? [] : [filter]);
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'AbortError')) throw new PickerCancelled();
    throw err;
  }
  try {
    const link = await SerialLink.open(port, {
      baudRate: 115200,
      dataTerminalReady: signals.dtr,
      requestToSend: signals.rts,
      bufferSize: bufferSizeFor(opts.backend),
    });
    return { link, port };
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'InvalidStateError') throw new Error('That port is already open in this tab. Disconnect first.', { cause: err });
    if (name === 'NetworkError' || name === 'SecurityError') {
      throw new Error(
        opts.backend === 'webusb'
          ? 'Could not claim the USB interface. On a computer, use "USB serial" instead; on Android, unplug and replug the analyzer, then try again.'
          : 'The port is busy. Close other programs using it (PulseView, the gusmanb app, a serial monitor) and try again.',
        { cause: err },
      );
    }
    throw err;
  }
}

export async function connectDevice(choice: DeviceChoice, opts: ConnectOptions): Promise<Connected> {
  switch (choice) {
    case 'demo':
      return { kind: 'demo', device: new DemoDevice() };
    case 'sim-gusmanb':
      return { kind: 'gusmanb', device: await connectSimulated('gusmanb'), simulated: true };
    case 'sim-sigrok-pico':
      return { kind: 'sigrok-pico', device: await connectSimulated('sigrok-pico'), simulated: true };
    case 'gusmanb': {
      // The firmware only talks once DTR is asserted.
      const { link, port } = await openPort(GUSMANB_USB_FILTER, opts, { dtr: true, rts: true });
      try {
        return { kind: 'gusmanb', device: await GusmanbDevice.connect(link, opts.signal), simulated: false, port };
      } catch (err) {
        await link.close();
        throw err;
      }
    }
    case 'sigrok-pico': {
      const { link, port } = await openPort(SIGROK_PICO_USB_FILTER, opts, { dtr: true, rts: false });
      try {
        return { kind: 'sigrok-pico', device: await SigrokPicoDevice.connect(link, opts.signal), simulated: false, port };
      } catch (err) {
        await link.close();
        throw err;
      }
    }
  }
}

export function choiceLabel(choice: DeviceChoice): string {
  return DEVICE_CHOICES.find((c) => c.id === choice)?.label ?? choice;
}
