/**
 * A realistic bench scenario for demos and simulated hardware: a
 * microcontroller printing over UART, talking to an I2C EEPROM, reading a SPI
 * flash's JEDEC ID, plus a PWM output and a heartbeat clock.
 *
 * Channel map (bit = channel):
 *   0 UART TX   1 UART RX
 *   2 I2C SCL   3 I2C SDA
 *   4 SPI CS    5 SPI SCK   6 SPI MOSI   7 SPI MISO
 *   8 PWM (1 kHz, 25%)      9 heartbeat (10 kHz clock)
 */
import { SignalBuilder } from '../../core/synth';
import type { SampleWords } from '../../core/capture';

export const DEMO_CHANNEL_NAMES = ['UART TX', 'UART RX', 'I2C SCL', 'I2C SDA', 'SPI CS', 'SPI SCK', 'SPI MOSI', 'SPI MISO', 'PWM', 'CLK 10k'];

export const DEMO_UART_BAUD = 115_200;
const I2C_FREQ = 400_000;
const SPI_FREQ = 1_000_000;
const PERIOD_S = 0.004;

const text = (s: string): number[] => Array.from(new TextEncoder().encode(s));

/** Highest channel count the scenario uses. */
export const DEMO_CHANNEL_COUNT = DEMO_CHANNEL_NAMES.length;

export interface ScenarioOptions {
  readonly sampleRate: number;
  readonly sampleCount: number;
  /** Width of the sample words; at least DEMO_CHANNEL_COUNT. */
  readonly channelCount?: number;
}

/** Builds the scenario. Protocol traffic needs at least ~4 MHz to decode cleanly. */
export function buildScenario(opts: ScenarioOptions): SampleWords {
  const { sampleRate, sampleCount } = opts;
  const b = new SignalBuilder(sampleRate, sampleCount, Math.max(opts.channelCount ?? DEMO_CHANNEL_COUNT, DEMO_CHANNEL_COUNT));
  const duration = sampleCount / sampleRate;
  b.idle(0, 1).idle(1, 1).idle(2, 1).idle(3, 1).idle(4, 1);

  const pwmFreq = Math.min(1000, sampleRate / 20);
  b.clock(8, 0, duration, pwmFreq, 0.25);
  b.clock(9, 0, duration, Math.min(10_000, sampleRate / 4), 0.5);

  // Protocol traffic only makes sense when bits span a few samples.
  const uartOk = sampleRate >= DEMO_UART_BAUD * 4;
  const i2cOk = sampleRate >= I2C_FREQ * 8;
  const spiOk = sampleRate >= SPI_FREQ * 4;
  let counter = 0;
  for (let t = 20e-6; t < duration - PERIOD_S * 0.9 || (t === 20e-6 && t < duration); t += PERIOD_S) {
    let cursor = t;
    if (uartOk) {
      const line = text(`Hello from Logic in a Tab #${counter}\r\n`);
      cursor = b.uart(0, cursor, line, { baud: DEMO_UART_BAUD });
      b.uart(1, cursor + 50e-6, text('OK\r\n'), { baud: DEMO_UART_BAUD });
    }
    if (i2cOk) {
      const reg = counter & 0xff;
      let i2cEnd = b.i2c(2, 3, t + 10e-6, [{ address: 0x50, read: false, data: [0x00, reg, 0x42, counter & 0xff] }], I2C_FREQ);
      i2cEnd = b.i2c(
        2,
        3,
        i2cEnd + 30e-6,
        [
          { address: 0x50, read: false, data: [0x00, reg] },
          { address: 0x50, read: true, data: [0x42, counter & 0xff] },
        ],
        I2C_FREQ,
      );
      b.i2c(2, 3, i2cEnd + 30e-6, [{ address: 0x3c, read: false, data: [0x80, 0xaf], nackAddress: counter % 4 === 3 }], I2C_FREQ);
    }
    if (spiOk) {
      const spiEnd = b.spi({ cs: 4, clk: 5, mosi: 6, miso: 7 }, t + 200e-6, [0x9f, 0x00, 0x00, 0x00], [0xff, 0xef, 0x40, 0x18], {
        freq: SPI_FREQ,
        mode: 0,
      });
      b.spi(
        { cs: 4, clk: 5, mosi: 6, miso: 7 },
        spiEnd + 20e-6,
        [0x03, 0x00, (counter >> 8) & 0xff, counter & 0xff, 0x00, 0x00],
        [0xff, 0xff, 0xff, 0xff, 0xde, 0xad],
        { freq: SPI_FREQ, mode: 0 },
      );
    }
    counter++;
    if (!uartOk && !i2cOk && !spiOk) break;
  }
  return b.build();
}

/** 7-bit analog test waveforms for the sigrok-pico simulator (raw ADC codes 0-127). */
export function analogScenario(channel: number, count: number, sampleRate: number): number[] {
  const out = new Array<number>(count);
  const freq = [50, 120, 333][channel % 3];
  for (let i = 0; i < count; i++) {
    const phase = ((i / sampleRate) * freq) % 1;
    const v =
      channel % 3 === 0
        ? 0.5 + 0.45 * Math.sin(2 * Math.PI * phase)
        : channel % 3 === 1
          ? phase < 0.5
            ? phase * 2
            : 2 - phase * 2
          : phase < 0.3
            ? 0.9
            : 0.1;
    out[i] = Math.max(0, Math.min(127, Math.round(v * 127)));
  }
  return out;
}
