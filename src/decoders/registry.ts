import { i2cDecoder } from './i2c';
import { spiDecoder } from './spi';
import type { DecoderDef } from './types';
import { uartDecoder } from './uart';

export const DECODERS: readonly DecoderDef[] = [uartDecoder, i2cDecoder, spiDecoder];

export function getDecoder(id: string): DecoderDef | undefined {
  return DECODERS.find((d) => d.id === id);
}
