/**
 * sigrok session files (.sr, "srzip" v2), compatible with PulseView 0.4.x and
 * libsigrok 0.5.x.
 *
 * Layout: a ZIP archive with
 *   version              the single byte "2"
 *   metadata             INI-style key file ([global] and [device 1])
 *   logic-1-1, -2, ...   raw logic samples, `unitsize` bytes each, little-endian
 *   analog-1-N-1, ...    float32 little-endian volts, N = analog channel key index
 *
 * This is an independent implementation written from the format description;
 * it shares no code with libsigrok.
 */
import { unzipSync, zip, unzip, type AsyncZippable, type Unzipped, type ZipOptions } from 'fflate';
import {
  allocWords,
  channelBitWidth,
  createCapture,
  wordBytesFor,
  type AnalogChannel,
  type Capture,
  type LogicChannel,
} from '../core/capture';
import { formatSamplerate, parseSizeString } from './sizestring';

/** Logic chunk size used by libsigrok's writer. */
const LOGIC_CHUNK_BYTES = 4 * 1024 * 1024;
/** Floats per analog chunk used by libsigrok's writer. */
const ANALOG_CHUNK_FLOATS = 1024 * 1024;
const SIGROK_VERSION = '0.5.2';

export class SrFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SrFormatError';
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Escapes a value the way GKeyFile does when writing. */
function escapeValue(value: string): string {
  let out = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  if (out.startsWith(' ')) out = `\\s${out.slice(1)}`;
  else if (out.startsWith('\t')) out = `\\t${out.slice(1)}`;
  return out;
}

/** Sigrok key files are line-based and keys like `probeN` must stay unique. */
function sanitizeName(name: string, fallback: string): string {
  const trimmed = name.replace(/[\r\n]/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function buildMetadata(capture: Capture): string {
  const lines: string[] = ['[global]', `sigrok version=${SIGROK_VERSION}`, '', '[device 1]'];
  const totalProbes = channelBitWidth(capture.channels);
  const hasLogic = capture.channels.length > 0;
  if (hasLogic) {
    lines.push('capturefile=logic-1', `total probes=${totalProbes}`);
  }
  lines.push(`samplerate=${formatSamplerate(capture.sampleRate)}`);
  lines.push(`total analog=${capture.analog.length}`);
  const sorted = [...capture.channels].sort((a, b) => a.index - b.index);
  for (const ch of sorted) {
    lines.push(`probe${ch.index + 1}=${escapeValue(sanitizeName(ch.name, `D${ch.index}`))}`);
  }
  const firstAnalog = hasLogic ? totalProbes + 1 : 1;
  capture.analog.forEach((a, k) => {
    lines.push(`analog${firstAnalog + k}=${escapeValue(sanitizeName(a.name, `A${k}`))}`);
  });
  if (hasLogic) lines.push(`unitsize=${unitSizeFor(totalProbes)}`);
  return `${lines.join('\n')}\n`;
}

function unitSizeFor(totalProbes: number): number {
  return Math.max(1, Math.ceil(totalProbes / 8));
}

/** Packs sample words into `unitsize`-byte little-endian records. */
function packLogic(capture: Capture, unitSize: number, start: number, end: number): Uint8Array {
  const out = new Uint8Array((end - start) * unitSize);
  const s = capture.samples;
  if (unitSize === s.BYTES_PER_ELEMENT && isLittleEndian()) {
    out.set(new Uint8Array(s.buffer, s.byteOffset + start * unitSize, (end - start) * unitSize));
    return out;
  }
  let o = 0;
  for (let i = start; i < end; i++) {
    let w = s[i];
    for (let b = 0; b < unitSize; b++) {
      out[o++] = w & 0xff;
      w >>>= 8;
    }
  }
  return out;
}

function float32ToLE(data: Float32Array, start: number, end: number): Uint8Array {
  const out = new Uint8Array((end - start) * 4);
  const view = new DataView(out.buffer);
  for (let i = start; i < end; i++) view.setFloat32((i - start) * 4, data[i], true);
  return out;
}

let littleEndianCache: boolean | undefined;
function isLittleEndian(): boolean {
  if (littleEndianCache === undefined) {
    littleEndianCache = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  }
  return littleEndianCache;
}

/** All entries of the .sr archive, in the order libsigrok writes them. */
export function buildSrEntries(capture: Capture): Array<[string, Uint8Array]> {
  const enc = new TextEncoder();
  const entries: Array<[string, Uint8Array]> = [
    ['version', enc.encode('2')],
    ['metadata', enc.encode(buildMetadata(capture))],
  ];
  if (capture.channels.length > 0) {
    const unitSize = unitSizeFor(channelBitWidth(capture.channels));
    const perChunk = Math.max(1, Math.floor(LOGIC_CHUNK_BYTES / unitSize));
    let chunk = 1;
    for (let start = 0; start < capture.sampleCount; start += perChunk) {
      const end = Math.min(start + perChunk, capture.sampleCount);
      entries.push([`logic-1-${chunk++}`, packLogic(capture, unitSize, start, end)]);
    }
    if (capture.sampleCount === 0) entries.push(['logic-1-1', new Uint8Array(0)]);
  }
  const firstAnalog = capture.channels.length > 0 ? channelBitWidth(capture.channels) + 1 : 1;
  capture.analog.forEach((a, k) => {
    const n = firstAnalog + k;
    let chunk = 1;
    for (let start = 0; start < a.data.length; start += ANALOG_CHUNK_FLOATS) {
      const end = Math.min(start + ANALOG_CHUNK_FLOATS, a.data.length);
      entries.push([`analog-1-${n}-${chunk++}`, float32ToLE(a.data, start, end)]);
    }
    if (a.data.length === 0) entries.push([`analog-1-${n}-1`, new Uint8Array(0)]);
  });
  return entries;
}

/** Serialises a capture to .sr bytes. Compression runs off the main thread. */
export function writeSr(capture: Capture, level: ZipOptions['level'] = 6): Promise<Uint8Array> {
  const files: AsyncZippable = {};
  for (const [name, data] of buildSrEntries(capture)) {
    // Tiny text entries are stored; sample data is deflated.
    files[name] = [data, { level: data.length < 64 ? 0 : level }];
  }
  return new Promise((resolve, reject) => {
    zip(files, { level }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface KeyFile {
  readonly groups: ReadonlyArray<{ readonly name: string; readonly entries: ReadonlyArray<readonly [string, string]> }>;
}

function unescapeValue(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case 's':
        return ' ';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case '\\':
        return '\\';
      default:
        return `\\${c}`;
    }
  });
}

/** Parses a GKeyFile-style document. Accepts CRLF, comments, and spaces around '='. */
export function parseKeyFile(text: string): KeyFile {
  const groups: Array<{ name: string; entries: Array<[string, string]> }> = [];
  let current: { name: string; entries: Array<[string, string]> } | undefined;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, lineNo) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return;
    const group = /^\[(.+)\]$/.exec(line);
    if (group) {
      current = { name: group[1].trim(), entries: [] };
      groups.push(current);
      return;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) throw new SrFormatError(`metadata line ${lineNo + 1} is not "key=value": ${raw}`);
    if (!current) throw new SrFormatError('metadata has a key before the first [group]');
    current.entries.push([line.slice(0, eq).trim(), unescapeValue(line.slice(eq + 1).trim())]);
  });
  return { groups };
}

interface DeviceMeta {
  capturefile?: string;
  totalProbes: number;
  sampleRate: number;
  unitSize: number;
  probes: Map<number, string>;
  analog: Map<number, string>;
}

function parseIntStrict(value: string, key: string): number {
  if (!/^\d+$/.test(value)) throw new SrFormatError(`metadata key "${key}" is not a number: ${value}`);
  return Number.parseInt(value, 10);
}

function readDeviceMeta(entries: ReadonlyArray<readonly [string, string]>): DeviceMeta {
  const meta: DeviceMeta = { totalProbes: 0, sampleRate: 0, unitSize: 0, probes: new Map(), analog: new Map() };
  for (const [key, value] of entries) {
    if (key === 'capturefile') meta.capturefile = value;
    else if (key === 'total probes') meta.totalProbes = parseIntStrict(value, key);
    else if (key === 'samplerate') {
      const rate = parseSizeString(value);
      if (!Number.isFinite(rate)) throw new SrFormatError(`Cannot parse samplerate "${value}"`);
      meta.sampleRate = rate;
    } else if (key === 'unitsize') meta.unitSize = parseIntStrict(value, key);
    else if (/^probe\d+$/.test(key)) meta.probes.set(Number.parseInt(key.slice(5), 10), value);
    else if (/^analog\d+$/.test(key)) meta.analog.set(Number.parseInt(key.slice(6), 10), value);
  }
  return meta;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Own-property lookup, so names from the file cannot reach Object.prototype. */
function entry(files: Unzipped, name: string): Uint8Array | undefined {
  if (!Object.hasOwn(files, name)) return undefined;
  const v = files[name];
  return v instanceof Uint8Array ? v : undefined;
}

/** Collects `<base>-1`, `<base>-2`, ... stopping at the first gap, or a bare `<base>`. */
function collectChunks(files: Unzipped, base: string): Uint8Array | undefined {
  const chunks: Uint8Array[] = [];
  for (let n = 1; ; n++) {
    const chunk = entry(files, `${base}-${n}`);
    if (!chunk) break;
    chunks.push(chunk);
  }
  if (chunks.length > 0) return concatChunks(chunks);
  return entry(files, base);
}

export interface SrReadResult {
  readonly capture: Capture;
  readonly warnings: readonly string[];
}

/** Builds a capture from the unzipped entries of a .sr archive. */
export function parseSrEntries(files: Unzipped, name = 'Imported capture'): SrReadResult {
  const warnings: string[] = [];
  const versionBytes = entry(files, 'version');
  if (!versionBytes) throw new SrFormatError('Not a sigrok session: missing "version" entry');
  const version = Number.parseInt(new TextDecoder().decode(versionBytes).trim(), 10);
  if (!(version === 1 || version === 2)) throw new SrFormatError(`Unsupported sigrok session version "${version}"`);
  const metaBytes = entry(files, 'metadata');
  if (!metaBytes) throw new SrFormatError('Not a sigrok session: missing "metadata" entry');

  const keyFile = parseKeyFile(new TextDecoder().decode(metaBytes));
  const devices = keyFile.groups.filter((g) => g.name.startsWith('device '));
  if (devices.length === 0) throw new SrFormatError('metadata has no [device] section');
  if (devices.length > 1) warnings.push(`File has ${devices.length} devices; only the first was loaded.`);
  const meta = readDeviceMeta(devices[0].entries);
  if (meta.sampleRate <= 0) {
    warnings.push('File has no sample rate; assuming 1 MHz.');
    meta.sampleRate = 1_000_000;
  }

  // Logic data
  let channels: LogicChannel[] = [];
  let samples = allocWords(0, 1);
  if (meta.capturefile) {
    const raw = collectChunks(files, meta.capturefile);
    if (!raw) throw new SrFormatError(`Logic data "${meta.capturefile}" is missing`);
    if (meta.unitSize <= 0) throw new SrFormatError('metadata is missing "unitsize"');
    let probeCount = meta.totalProbes;
    for (const n of meta.probes.keys()) probeCount = Math.max(probeCount, n);
    const usableBits = Math.min(probeCount, meta.unitSize * 8, 32);
    if (probeCount > 32) warnings.push(`File has ${probeCount} probes; only the first 32 were loaded.`);
    if (raw.length % meta.unitSize !== 0) warnings.push('Logic data length is not a multiple of unitsize; the last partial sample was dropped.');
    const count = Math.floor(raw.length / meta.unitSize);
    samples = unpackLogic(raw, meta.unitSize, count, wordBytesFor(Math.max(1, usableBits)));
    channels = [...meta.probes.entries()]
      .filter(([n]) => n >= 1 && n <= usableBits)
      .sort((a, b) => a[0] - b[0])
      .map(([n, chName]) => ({ index: n - 1, name: chName }));
    if (usableBits < 32) {
      const mask = usableBits >= 32 ? 0xffffffff : (2 ** usableBits - 1);
      if (mask !== 0xffffffff) for (let i = 0; i < samples.length; i++) samples[i] &= mask;
    }
  }

  // Analog data
  const analog: AnalogChannel[] = [];
  const analogKeys = [...meta.analog.entries()].sort((a, b) => a[0] - b[0]);
  for (const [n, chName] of analogKeys) {
    const raw = collectChunks(files, `analog-1-${n}`);
    if (!raw) {
      warnings.push(`Analog channel ${chName} has no data and was skipped.`);
      continue;
    }
    const { data, invalid } = float32FromLE(raw);
    if (invalid > 0) warnings.push(`Analog channel ${chName} had ${invalid} invalid values (NaN or infinity); they were set to 0.`);
    analog.push({ name: chName, unit: 'V', data });
  }

  // Align lengths: every channel shares one timebase.
  const lengths = [...(meta.capturefile ? [samples.length] : []), ...analog.map((a) => a.data.length)];
  const sampleCount = lengths.length > 0 ? Math.min(...lengths) : 0;
  if (lengths.some((l) => l !== sampleCount)) warnings.push('Channels had different lengths; trimmed to the shortest.');
  if (!meta.capturefile) samples = allocWords(sampleCount, 1);

  const capture = createCapture({
    name,
    sampleRate: meta.sampleRate,
    channels,
    samples: samples.length === sampleCount ? samples : samples.slice(0, sampleCount),
    analog: analog.map((a) => (a.data.length === sampleCount ? a : { ...a, data: a.data.slice(0, sampleCount) })),
    source: 'sigrok .sr file',
  });
  return { capture, warnings };
}

function unpackLogic(raw: Uint8Array, unitSize: number, count: number, wordBytes: 1 | 2 | 4) {
  const out = allocWords(count, wordBytes);
  const take = Math.min(unitSize, 4);
  for (let i = 0, o = 0; i < count; i++, o += unitSize) {
    let w = 0;
    for (let b = take - 1; b >= 0; b--) w = (w * 256 + raw[o + b]) >>> 0;
    out[i] = w;
  }
  return out;
}

/** Decodes float32 LE values; non-finite values (which would break autoscaling) become 0. */
function float32FromLE(raw: Uint8Array): { data: Float32Array; invalid: number } {
  const count = Math.floor(raw.length / 4);
  const data = new Float32Array(count);
  const view = new DataView(raw.buffer, raw.byteOffset, count * 4);
  let invalid = 0;
  for (let i = 0; i < count; i++) {
    const v = view.getFloat32(i * 4, true);
    if (Number.isFinite(v)) data[i] = v;
    else invalid++;
  }
  return { data, invalid };
}

/** Largest total uncompressed size we are willing to inflate (protects against zip bombs). */
export const MAX_UNCOMPRESSED_BYTES = 1.5 * 1024 ** 3;

/** Entries a session can contain; anything else in the archive is never inflated. */
function isSessionEntry(name: string): boolean {
  return name === 'version' || name === 'metadata' || /^(logic-\d+|analog-\d+-\d+)(-\d+)?$/.test(name);
}

/**
 * Unzips only session entries, refusing archives whose declared size exceeds
 * MAX_UNCOMPRESSED_BYTES. Uses fflate's worker-backed unzip when workers exist.
 */
function unzipSession(bytes: Uint8Array): Promise<Unzipped> {
  let total = 0;
  let tooBig = false;
  const filter = (file: { name: string; originalSize: number }): boolean => {
    if (!isSessionEntry(file.name)) return false;
    total += file.originalSize;
    if (total > MAX_UNCOMPRESSED_BYTES) tooBig = true;
    return !tooBig;
  };
  const check = (files: Unzipped): Unzipped => {
    if (tooBig) {
      throw new SrFormatError(`This file expands to more than ${Math.round(MAX_UNCOMPRESSED_BYTES / 1024 ** 3 * 10) / 10} GB, which is too large to open here.`);
    }
    return files;
  };
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => check(unzipSync(bytes, { filter })));
  return new Promise((resolve, reject) => {
    unzip(bytes, { filter }, (err, out) => {
      if (err) reject(err);
      else {
        try {
          resolve(check(out));
        } catch (e) {
          reject(e);
        }
      }
    });
  });
}

/** Reads .sr bytes into a capture. */
export async function readSr(bytes: Uint8Array, name?: string): Promise<SrReadResult> {
  let files: Unzipped;
  try {
    files = await unzipSession(bytes);
  } catch (err) {
    if (err instanceof SrFormatError) throw err;
    throw new SrFormatError(`Not a valid .sr (ZIP) file: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseSrEntries(files, name);
}
