/** Capture + derived indexes + decoder setups: everything the views need. */
import type { Capture } from '../core/capture';
import { AnalogPyramid, LogicPyramid } from '../core/pyramid';
import { getDecoder } from '../decoders/registry';
import { defaultOptions, type ChannelAssignment, type DecodeOutput, type DecoderDef, type OptionValues } from '../decoders/types';

export interface Workspace {
  readonly capture: Capture;
  readonly pyramid: LogicPyramid;
  readonly analog: readonly AnalogPyramid[];
}

export function buildWorkspace(capture: Capture): Workspace {
  return {
    capture,
    pyramid: new LogicPyramid(capture.samples),
    analog: capture.analog.map((a) => new AnalogPyramid(a.data)),
  };
}

export interface DecoderInstance {
  readonly uid: string;
  readonly decoderId: string;
  readonly channels: ChannelAssignment;
  readonly options: OptionValues;
  /** Decoder row ids the user has hidden. */
  readonly hiddenRows: readonly string[];
}

export type DecoderResult =
  { readonly ok: true; readonly output: DecodeOutput; readonly ms: number } | { readonly ok: false; readonly error: string };

/** Name fragments that suggest a decoder input, most specific first. */
const CHANNEL_HINTS: Record<string, readonly string[]> = {
  rx: ['rx', 'rxd', 'uart_rx'],
  tx: ['tx', 'txd', 'uart_tx'],
  scl: ['scl'],
  sda: ['sda'],
  clk: ['sck', 'sclk', 'spiclk', 'clk', 'clock'],
  mosi: ['mosi', 'copi', 'sdo', 'dout'],
  miso: ['miso', 'cipo', 'sdi', 'din'],
  cs: ['cs', 'ss', 'nss', 'ncs', 'csn', 'cs0'],
};

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

/** Guesses a channel mapping from channel names, falling back to the first channels in order. */
export function autoAssign(def: DecoderDef, capture: Capture): ChannelAssignment {
  const used = new Set<number>();
  const result: Record<string, number | undefined> = {};
  const named = capture.channels.map((c) => ({ index: c.index, tokens: tokens(c.name) }));
  for (const spec of def.channels) {
    for (const hint of CHANNEL_HINTS[spec.id] ?? [spec.id]) {
      const hit = named.find((c) => !used.has(c.index) && c.tokens.includes(hint));
      if (hit) {
        result[spec.id] = hit.index;
        used.add(hit.index);
        break;
      }
    }
  }
  const matchedAny = Object.keys(result).length > 0;
  for (const spec of def.channels) {
    if (result[spec.id] !== undefined) continue;
    if (spec.required || !matchedAny) {
      const free = capture.channels.find((c) => !used.has(c.index));
      if (free) {
        result[spec.id] = free.index;
        used.add(free.index);
      }
    }
  }
  return result;
}

export function newDecoderInstance(decoderId: string, capture: Capture | undefined): DecoderInstance {
  const def = getDecoder(decoderId);
  if (!def) throw new Error(`Unknown decoder ${decoderId}`);
  return {
    uid: `${decoderId}-${Math.random().toString(36).slice(2, 8)}`,
    decoderId,
    channels: capture ? autoAssign(def, capture) : {},
    options: defaultOptions(def),
    hiddenRows: def.rows.filter((r) => r.id.endsWith('bits')).map((r) => r.id),
  };
}

/** Drops channel assignments that do not exist in `capture`. */
export function reconcileChannels(inst: DecoderInstance, capture: Capture): DecoderInstance {
  const valid = new Set(capture.channels.map((c) => c.index));
  const channels = Object.fromEntries(Object.entries(inst.channels).map(([k, v]) => [k, v !== undefined && valid.has(v) ? v : undefined]));
  return { ...inst, channels };
}

export function runDecoder(inst: DecoderInstance, ws: Workspace): DecoderResult {
  const def = getDecoder(inst.decoderId);
  if (!def) return { ok: false, error: `Unknown decoder "${inst.decoderId}".` };
  const missing = def.channels.filter((c) => c.required && inst.channels[c.id] === undefined);
  if (missing.length > 0) return { ok: false, error: `Connect ${missing.map((m) => m.label).join(' and ')}.` };
  try {
    const t0 = performance.now();
    const output = def.decode({ pyramid: ws.pyramid, sampleRate: ws.capture.sampleRate }, inst.channels, inst.options);
    return { ok: true, output, ms: performance.now() - t0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Stable key for memoising decoder runs. */
export function decoderKey(inst: DecoderInstance, captureId: string): string {
  return `${captureId}|${inst.decoderId}|${JSON.stringify(inst.channels)}|${JSON.stringify(inst.options)}`;
}
