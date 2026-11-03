import { describe, expect, it } from 'vitest';
import { FakePort, type FakeFirmware } from '../sim/fakePort';
import { AbortedError, SerialLink, TimeoutError } from './link';

class Echo implements FakeFirmware {
  received: number[] = [];
  receive(bytes: Uint8Array, port: FakePort): void {
    this.received.push(...bytes);
    port.send(bytes, 1);
  }
}

async function openLink(fw: FakeFirmware = new Echo()): Promise<{ link: SerialLink; port: FakePort }> {
  const port = new FakePort(fw);
  const link = await SerialLink.open(port, { dataTerminalReady: true, requestToSend: true });
  return { link, port };
}

describe('SerialLink', () => {
  it('asserts the requested control signals on open', async () => {
    const { link, port } = await openLink();
    expect(port.signals).toEqual({ dataTerminalReady: true, requestToSend: true });
    await link.close();
  });

  it('reads lines and strips CR', async () => {
    const { link, port } = await openLink();
    port.send('hello\r\nworld\n', 3);
    expect(await link.readLine({ timeoutMs: 500 })).toBe('hello');
    expect(await link.readLine({ timeoutMs: 500 })).toBe('world');
    await link.close();
  });

  it('reads exact byte counts across chunk boundaries with progress', async () => {
    const { link, port } = await openLink();
    const data = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
    const progress: number[] = [];
    const read = link.readExact(1000, { timeoutMs: 1000, onProgress: (r) => progress.push(r) });
    port.send(data, 37);
    const got = await read;
    expect(Array.from(got)).toEqual(Array.from(data));
    expect(progress[progress.length - 1]).toBe(1000);
    await link.close();
  });

  it('times out when data does not arrive', async () => {
    const { link } = await openLink();
    await expect(link.readExact(4, { timeoutMs: 30 })).rejects.toBeInstanceOf(TimeoutError);
    await link.close();
  });

  it('can be aborted', async () => {
    const { link } = await openLink();
    const ctrl = new AbortController();
    const pending = link.readLine({ signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortedError);
    await link.close();
  });

  it('writes go to the device', async () => {
    const echo = new Echo();
    const { link } = await openLink(echo);
    await link.write('ab');
    await link.write(new Uint8Array([1, 2]));
    expect(echo.received).toEqual([97, 98, 1, 2]);
    expect(Array.from(await link.readExact(4, { timeoutMs: 500 }))).toEqual([97, 98, 1, 2]);
    await link.close();
  });

  it('readUntilQuiet collects a burst and stops when the line goes quiet', async () => {
    const { link, port } = await openLink();
    port.send('abc');
    const got = await link.readUntilQuiet(30, 1000);
    expect(new TextDecoder().decode(got)).toBe('abc');
    await link.close();
  });

  it('readMatching finds a pattern spread over chunks', async () => {
    const { link, port } = await openLink();
    port.send('noiseSRPICO,A031D21,02', 2);
    const m = await link.readMatching(/SRPICO,A(\d\d)/, { timeoutMs: 500 });
    expect(m[1]).toBe('03');
    await link.close();
  });

  it('rejects pending reads when the device disappears', async () => {
    const { link, port } = await openLink();
    const pending = link.readLine({ timeoutMs: 1000 });
    await port.close();
    await expect(pending).rejects.toThrow();
  });
});
