import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createCapture } from '../core/capture';
import { buildMetadata, buildSrEntries, parseKeyFile, parseSrEntries, readSr, writeSr } from './srzip';
import { formatSamplerate, parseSizeString } from './sizestring';

describe('samplerate strings', () => {
  it.each([
    [0, '0 Hz'],
    [500, '500 Hz'],
    [1500, '1.5 kHz'],
    [500000, '500 kHz'],
    [999999, '999.999 kHz'],
    [1000000, '1 MHz'],
    [12500000, '12.5 MHz'],
    [33333333, '33.333333 MHz'],
    [1000000000, '1 GHz'],
  ])('formats %i as %s like libsigrok', (hz, text) => {
    expect(formatSamplerate(hz)).toBe(text);
    expect(parseSizeString(text)).toBe(hz);
  });

  it('parses loose user input', () => {
    expect(parseSizeString('2m')).toBe(2_000_000);
    expect(parseSizeString('48000')).toBe(48000);
    expect(parseSizeString('12.5MHz')).toBe(12_500_000);
    expect(parseSizeString('fast')).toBeNaN();
  });
});

function logicCapture(channels: number, count: number) {
  const words = channels <= 8 ? new Uint8Array(count) : channels <= 16 ? new Uint16Array(count) : new Uint32Array(count);
  for (let i = 0; i < count; i++) words[i] = ((i * 2654435761) >>> 0) & (2 ** channels - 1);
  return createCapture({
    sampleRate: 1_000_000,
    channels: Array.from({ length: channels }, (_, i) => ({ index: i, name: `D${i}` })),
    samples: words,
    source: 'test',
  });
}

describe('metadata', () => {
  it('matches libsigrok output for 8 channels at 1 MHz', () => {
    const meta = buildMetadata(logicCapture(8, 10));
    expect(meta).toBe(
      '[global]\nsigrok version=0.5.2\n\n[device 1]\ncapturefile=logic-1\ntotal probes=8\nsamplerate=1 MHz\ntotal analog=0\n' +
        'probe1=D0\nprobe2=D1\nprobe3=D2\nprobe4=D3\nprobe5=D4\nprobe6=D5\nprobe7=D6\nprobe8=D7\nunitsize=1\n',
    );
  });

  it('numbers analog channels after all logic probes, including gaps', () => {
    const cap = createCapture({
      sampleRate: 500_000,
      channels: [
        { index: 0, name: 'CLK' },
        { index: 15, name: 'CS' },
      ],
      samples: new Uint16Array(4),
      analog: [
        { name: 'A0', unit: 'V', data: new Float32Array(4) },
        { name: 'A1', unit: 'V', data: new Float32Array(4) },
      ],
      source: 'test',
    });
    const meta = buildMetadata(cap);
    expect(meta).toContain('total probes=16\nsamplerate=500 kHz\ntotal analog=2\nprobe1=CLK\nprobe16=CS\nanalog17=A0\nanalog18=A1\nunitsize=2\n');
    const names = buildSrEntries(cap).map(([n]) => n);
    expect(names).toEqual(['version', 'metadata', 'logic-1-1', 'analog-1-17-1', 'analog-1-18-1']);
  });

  it('escapes backslashes like GKeyFile and trims names', () => {
    const cap = createCapture({ sampleRate: 1000, channels: [{ index: 0, name: ' a\\b ' }], samples: new Uint8Array(1), source: 't' });
    expect(buildMetadata(cap)).toContain('probe1=a\\\\b\n');
    const parsed = parseKeyFile(buildMetadata(cap));
    expect(parsed.groups[1].entries.find(([k]) => k === 'probe1')?.[1]).toBe('a\\b');
  });
});

describe('round trip', () => {
  it.each([4, 8, 12, 24, 32])('preserves %i-channel logic data', async (channels) => {
    const cap = logicCapture(channels, 5000);
    const bytes = await writeSr(cap);
    const { capture, warnings } = await readSr(bytes);
    expect(warnings).toEqual([]);
    expect(capture.sampleRate).toBe(1_000_000);
    expect(capture.sampleCount).toBe(5000);
    expect(capture.channels.map((c) => c.name)).toEqual(cap.channels.map((c) => c.name));
    expect(Array.from(capture.samples)).toEqual(Array.from(cap.samples));
  });

  it('uses 3-byte units for 24 channels, as sigrok does', () => {
    const files = buildSrEntries(logicCapture(24, 10));
    const logic = files.find(([n]) => n === 'logic-1-1')?.[1];
    expect(logic?.length).toBe(30);
  });

  it('splits logic data into 4 MiB chunks', () => {
    const files = buildSrEntries(logicCapture(16, 3_000_000));
    expect(files.filter(([n]) => n.startsWith('logic-1-')).map(([n]) => n)).toEqual(['logic-1-1', 'logic-1-2']);
  });

  it('preserves analog data', async () => {
    const data = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 10) * 3.3);
    const cap = createCapture({
      sampleRate: 100_000,
      channels: [{ index: 0, name: 'D0' }],
      samples: new Uint8Array(100),
      analog: [{ name: 'ADC0', unit: 'V', data }],
      source: 't',
    });
    const { capture } = parseSrEntries(unzipSync(zipSync(Object.fromEntries(buildSrEntries(cap)))));
    expect(capture.analog[0].name).toBe('ADC0');
    expect(Array.from(capture.analog[0].data)).toEqual(Array.from(data));
  });
});

describe('reading other writers', () => {
  it('reads v1-style metadata with spaces, CRLF and an unchunked logic-1', () => {
    const files = {
      version: strToU8('1'),
      metadata: strToU8('[device 1]\r\ndriver = fx2lafw\r\ncapturefile = logic-1\r\nunitsize = 1\r\ntotal probes = 8\r\nsamplerate = 24 MHz\r\nprobe1 = SCL\r\nprobe2 = SDA\r\n'),
      'logic-1': new Uint8Array([0, 1, 2, 3, 0xff]),
    };
    const { capture } = parseSrEntries(files);
    expect(capture.sampleRate).toBe(24_000_000);
    expect(capture.channels).toEqual([
      { index: 0, name: 'SCL' },
      { index: 1, name: 'SDA' },
    ]);
    // Bits of unnamed probes stay in the data; only named probes become channels.
    expect(Array.from(capture.samples)).toEqual([0, 1, 2, 3, 255]);
  });

  it('reads analog-only sessions', () => {
    const floats = new Float32Array([1.5, 2.5]);
    const files = {
      version: strToU8('2'),
      metadata: strToU8('[global]\nsigrok version=0.5.2\n\n[device 1]\nsamplerate=1 kHz\ntotal analog=1\nanalog1=CH1\n'),
      'analog-1-1-1': new Uint8Array(floats.buffer),
    };
    const { capture } = parseSrEntries(files);
    expect(capture.channels).toEqual([]);
    expect(capture.sampleCount).toBe(2);
    expect(Array.from(capture.analog[0].data)).toEqual([1.5, 2.5]);
  });

  it('rejects files that are not sigrok sessions', async () => {
    expect(() => parseSrEntries({ metadata: strToU8('') })).toThrow(/version/);
    expect(() => parseSrEntries({ version: strToU8('3'), metadata: strToU8('') })).toThrow(/version/);
    expect(() => parseSrEntries({ version: strToU8('2'), metadata: strToU8('[global]\n') })).toThrow(/device/);
    await expect(readSr(new Uint8Array([1, 2, 3]))).rejects.toThrow(/ZIP/);
  });

  it('warns and recovers when data is ragged', () => {
    const files = {
      version: strToU8('2'),
      metadata: strToU8('[device 1]\ncapturefile=logic-1\ntotal probes=16\nsamplerate=1 MHz\nprobe1=A\nunitsize=2\n'),
      'logic-1-1': new Uint8Array([1, 0, 2]),
    };
    const { capture, warnings } = parseSrEntries(files);
    expect(capture.sampleCount).toBe(1);
    expect(warnings.join()).toMatch(/partial/);
  });
});
