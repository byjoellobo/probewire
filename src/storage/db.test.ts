import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createCapture } from '../core/capture';
import { deleteCapture, listCaptures, loadCapture, resetDbConnection, saveCapture, updateMeta } from './db';

function capture(count: number) {
  const samples = new Uint16Array(count);
  for (let i = 0; i < count; i++) samples[i] = (i * 31) & 0xffff;
  return createCapture({
    name: 'test',
    sampleRate: 2_000_000,
    channels: [
      { index: 0, name: 'SCL' },
      { index: 9, name: 'SDA' },
    ],
    samples,
    analog: [{ name: 'ADC0', unit: 'V', data: Float32Array.from({ length: count }, (_, i) => i / 10) }],
    triggerSample: 5,
    source: 'unit test',
  });
}

afterEach(async () => {
  for (const m of await listCaptures()) await deleteCapture(m.id);
  await resetDbConnection();
});

describe('capture library', () => {
  it('saves and loads a capture exactly', async () => {
    const cap = capture(1000);
    const meta = await saveCapture(cap, [{ uid: 'd1', decoderId: 'i2c', channels: { scl: 0, sda: 9 }, options: { format: 'hex' } }]);
    expect(meta.byteSize).toBe(2000 + 4000);
    const { capture: loaded, meta: loadedMeta } = await loadCapture(cap.id);
    expect(loaded.channels).toEqual(cap.channels);
    expect(loaded.triggerSample).toBe(5);
    expect(Array.from(loaded.samples)).toEqual(Array.from(cap.samples));
    expect(Array.from(loaded.analog[0].data)).toEqual(Array.from(cap.analog[0].data));
    expect(loadedMeta.decoders[0].decoderId).toBe('i2c');
  });

  it('handles captures larger than one chunk', async () => {
    const cap = capture(5_000_000); // 10 MB of logic data -> 2 chunks
    await saveCapture(cap);
    const { capture: loaded } = await loadCapture(cap.id);
    expect(loaded.samples[4_999_999]).toBe(cap.samples[4_999_999]);
    expect(loaded.analog[0].data[4_999_999]).toBeCloseTo(cap.analog[0].data[4_999_999]);
  }, 30_000);

  it('lists newest first, renames and deletes', async () => {
    const a = createCapture({ ...capture(10), createdAt: 1000, id: 'a' });
    const b = createCapture({ ...capture(10), createdAt: 2000, id: 'b' });
    await saveCapture(a);
    await saveCapture(b);
    expect((await listCaptures()).map((m) => m.id)).toEqual(['b', 'a']);
    await updateMeta('a', { name: 'renamed' });
    expect((await listCaptures()).find((m) => m.id === 'a')?.name).toBe('renamed');
    await deleteCapture('b');
    expect((await listCaptures()).map((m) => m.id)).toEqual(['a']);
    await expect(loadCapture('b')).rejects.toThrow(/no longer/);
  });
});
