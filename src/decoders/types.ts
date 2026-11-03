/**
 * Protocol decoder contract.
 *
 * Decoders are pure functions over a LogicPyramid: no DOM, no globals, so they
 * can run in a worker or in tests unchanged. Annotation positions are sample
 * indices on the capture timebase.
 */
import type { LogicPyramid } from '../core/pyramid';

export type AnnotationKind =
  | 'data'
  | 'address'
  | 'control'
  | 'ack'
  | 'nack'
  | 'bit'
  | 'summary'
  | 'warning'
  | 'error';

export interface Annotation {
  /** First sample covered (inclusive). */
  readonly start: number;
  /** Sample after the last one covered (exclusive). Always > start. */
  readonly end: number;
  /** Index into DecoderDef.rows. */
  readonly row: number;
  readonly kind: AnnotationKind;
  /** Display variants, longest first. The renderer picks the longest that fits. */
  readonly texts: readonly string[];
  /** Numeric payload (byte value, address) for tables and export. */
  readonly value?: number;
}

export interface DecoderChannelSpec {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly description: string;
}

export interface NumberOptionSpec {
  readonly kind: 'number';
  readonly id: string;
  readonly label: string;
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
}

export interface SelectOptionSpec {
  readonly kind: 'select';
  readonly id: string;
  readonly label: string;
  readonly default: string;
  readonly choices: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

export type DecoderOptionSpec = NumberOptionSpec | SelectOptionSpec;

export interface DecoderRowSpec {
  readonly id: string;
  readonly label: string;
}

export interface DecoderInput {
  readonly pyramid: LogicPyramid;
  readonly sampleRate: number;
}

/** Decoder channel id -> logic channel bit index (undefined = not connected). */
export type ChannelAssignment = Readonly<Record<string, number | undefined>>;
export type OptionValues = Readonly<Record<string, number | string>>;

export interface DecodeOutput {
  /** Sorted by start sample. */
  readonly annotations: readonly Annotation[];
  /** Human-readable problems with the setup or the signal. */
  readonly warnings: readonly string[];
}

export interface DecoderDef {
  readonly id: string;
  readonly name: string;
  readonly longName: string;
  readonly description: string;
  readonly channels: readonly DecoderChannelSpec[];
  readonly options: readonly DecoderOptionSpec[];
  readonly rows: readonly DecoderRowSpec[];
  decode(input: DecoderInput, channels: ChannelAssignment, options: OptionValues): DecodeOutput;
}

export type DataFormat = 'hex' | 'dec' | 'bin' | 'ascii';

export const DATA_FORMAT_OPTION: SelectOptionSpec = {
  kind: 'select',
  id: 'format',
  label: 'Display as',
  default: 'hex',
  choices: [
    { value: 'hex', label: 'Hex' },
    { value: 'dec', label: 'Decimal' },
    { value: 'bin', label: 'Binary' },
    { value: 'ascii', label: 'ASCII' },
  ],
};

/** Formats a data word. `bits` controls hex/binary padding. */
export function formatValue(value: number, bits: number, format: DataFormat): string {
  switch (format) {
    case 'dec':
      return String(value);
    case 'bin':
      return value.toString(2).padStart(bits, '0');
    case 'ascii':
      return asciiLabel(value) ?? `0x${hex(value, bits)}`;
    case 'hex':
    default:
      return `0x${hex(value, bits)}`;
  }
}

/** Short form without the 0x prefix, used when space is tight. */
export function formatValueShort(value: number, bits: number, format: DataFormat): string {
  switch (format) {
    case 'dec':
      return String(value);
    case 'bin':
      return value.toString(2).padStart(bits, '0');
    case 'ascii':
      return asciiLabel(value) ?? hex(value, bits);
    case 'hex':
    default:
      return hex(value, bits);
  }
}

export function hex(value: number, bits: number): string {
  return value.toString(16).toUpperCase().padStart(Math.ceil(bits / 4), '0');
}

const CONTROL_NAMES: Record<number, string> = {
  0: 'NUL',
  7: 'BEL',
  8: 'BS',
  9: '\\t',
  10: '\\n',
  13: '\\r',
  27: 'ESC',
  127: 'DEL',
};

function asciiLabel(value: number): string | undefined {
  if (value >= 32 && value < 127) return `'${String.fromCharCode(value)}'`;
  return CONTROL_NAMES[value];
}

export function readOption<T extends number | string>(options: OptionValues, spec: DecoderOptionSpec): T {
  const v = options[spec.id];
  if (v === undefined) return spec.default as T;
  if (spec.kind === 'number') {
    const n = typeof v === 'number' ? v : Number(v);
    return (Number.isFinite(n) ? n : spec.default) as T;
  }
  const valid = spec.choices.some((c) => c.value === v);
  return (valid ? v : spec.default) as T;
}

export function defaultOptions(def: DecoderDef): Record<string, number | string> {
  return Object.fromEntries(def.options.map((o) => [o.id, o.default]));
}
