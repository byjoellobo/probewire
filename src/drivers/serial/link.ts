/**
 * Byte-stream link over a Web Serial (or polyfilled WebUSB) port.
 *
 * A background pump moves incoming chunks into a queue; protocol code then
 * asks for "a line", "exactly N bytes" or "whatever arrives until the line is
 * quiet", each with a timeout and an optional AbortSignal.
 */

/** The subset of the Web Serial SerialPort the drivers rely on. */
export interface PortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  setSignals?(signals: SerialOutputSignals): Promise<void>;
  getInfo?(): Partial<SerialPortInfo>;
}

export interface LinkOptions {
  baudRate?: number;
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  bufferSize?: number;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class AbortedError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'AbortedError';
  }
}

export class LinkClosedError extends Error {
  constructor(message = 'The device was disconnected') {
    super(message);
    this.name = 'LinkClosedError';
  }
}

export class DataLossError extends Error {
  constructor(message = 'Some bytes from the device were lost (serial buffer overrun). Try a lower sample rate or fewer channels.') {
    super(message);
    this.name = 'DataLossError';
  }
}

/** close() gives up waiting on a wedged port after this long. */
const CLOSE_TIMEOUT_MS = 2000;

export interface ReadOptions {
  /** Milliseconds; omit or Infinity to wait forever. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ReadExactOptions extends ReadOptions {
  onProgress?: (received: number, total: number) => void;
}

export class SerialLink {
  private readonly port: PortLike;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private queue: Uint8Array[] = [];
  private queueHead = 0;
  private buffered = 0;
  private waiters: Array<() => void> = [];
  private closing = false;
  private fatal: Error | undefined;
  private losses = 0;
  private readonly pumpDone: Promise<void>;

  private constructor(port: PortLike) {
    this.port = port;
    if (!port.writable) throw new LinkClosedError('Port is not writable');
    this.writer = port.writable.getWriter();
    this.pumpDone = this.pump();
  }

  static async open(port: PortLike, options: LinkOptions = {}): Promise<SerialLink> {
    await port.open({ baudRate: options.baudRate ?? 115200, bufferSize: options.bufferSize ?? 65536 });
    if (port.setSignals) {
      try {
        await port.setSignals({
          dataTerminalReady: options.dataTerminalReady ?? true,
          requestToSend: options.requestToSend ?? false,
        });
      } catch {
        // Some USB-serial bridges reject control signals. The Pico CDC stack
        // accepts them; if it fails the handshake will report the problem.
      }
    }
    try {
      return new SerialLink(port);
    } catch (err) {
      // Do not leave the port open (and locked) if the link cannot be built.
      await port.close().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Counts serial errors that dropped bytes (buffer overrun, framing). Reads
   * fail with DataLossError when this changes underneath them.
   */
  get lossCount(): number {
    return this.losses;
  }

  /** Number of bytes waiting to be read. */
  get available(): number {
    return this.buffered;
  }

  get isClosed(): boolean {
    return this.closing || this.fatal !== undefined;
  }

  async write(data: Uint8Array | string): Promise<void> {
    this.assertOpen();
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await this.writer.write(bytes);
  }

  /** Drops everything currently buffered. */
  discard(): void {
    this.queue = [];
    this.queueHead = 0;
    this.buffered = 0;
  }

  /** Returns and removes everything currently buffered. */
  takeAvailable(): Uint8Array {
    return this.take(this.buffered);
  }

  /** Waits until at least one byte is buffered. */
  async waitForData(options: ReadOptions = {}): Promise<void> {
    const deadline = deadlineFrom(options.timeoutMs);
    while (this.buffered === 0) await this.waitForMore(deadline, options.signal, 'data');
  }

  async readExact(count: number, options: ReadExactOptions = {}): Promise<Uint8Array> {
    const out = new Uint8Array(count);
    let filled = 0;
    const deadline = deadlineFrom(options.timeoutMs);
    const losses = this.losses;
    while (filled < count) {
      if (this.buffered === 0) await this.waitForMore(deadline, options.signal, `${count - filled} more bytes`);
      // Binary data with a hole in it is misaligned from that point on.
      if (this.losses !== losses) throw new DataLossError();
      const chunk = this.take(Math.min(this.buffered, count - filled));
      out.set(chunk, filled);
      filled += chunk.length;
      options.onProgress?.(filled, count);
    }
    return out;
  }

  /** Reads one line, stripping the trailing "\n" and any "\r". */
  async readLine(options: ReadOptions & { maxLength?: number } = {}): Promise<string> {
    const maxLength = options.maxLength ?? 4096;
    const deadline = deadlineFrom(options.timeoutMs);
    const bytes: number[] = [];
    for (;;) {
      if (this.buffered === 0) await this.waitForMore(deadline, options.signal, 'a line of text');
      const b = this.take(1)[0];
      if (b === 0x0a) break;
      if (b !== 0x0d) bytes.push(b);
      if (bytes.length > maxLength) throw new Error(`Line longer than ${maxLength} bytes; is this the right device?`);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  /**
   * Collects bytes until nothing new arrives for `quietMs`, or `maxMs` passes.
   * Useful for flushing stale output and for replies without a terminator.
   */
  async readUntilQuiet(quietMs: number, maxMs = 5000, signal?: AbortSignal): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    const hardDeadline = Date.now() + maxMs;
    for (;;) {
      if (this.buffered > 0) parts.push(this.takeAvailable());
      const deadline = Math.min(Date.now() + quietMs, hardDeadline);
      if (Date.now() >= hardDeadline) break;
      try {
        await this.waitForMore(deadline, signal, 'data');
      } catch (err) {
        if (err instanceof TimeoutError) break;
        throw err;
      }
    }
    if (this.buffered > 0) parts.push(this.takeAvailable());
    return concat(parts);
  }

  /** Reads text until `pattern` matches the accumulated reply. Returns the match. */
  async readMatching(pattern: RegExp, options: ReadOptions = {}): Promise<RegExpExecArray> {
    const deadline = deadlineFrom(options.timeoutMs);
    let text = '';
    for (;;) {
      const m = pattern.exec(text);
      if (m) return m;
      if (this.buffered === 0) await this.waitForMore(deadline, options.signal, `a reply matching ${pattern}`);
      text += new TextDecoder().decode(this.takeAvailable());
      if (text.length > 8192) text = text.slice(-4096);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.wakeAll();
    // Each step is bounded: a wedged (e.g. polyfilled) port must not hang reconnects.
    await withTimeout(Promise.resolve(this.reader?.cancel()), CLOSE_TIMEOUT_MS);
    await withTimeout(this.pumpDone, CLOSE_TIMEOUT_MS);
    try {
      this.writer.releaseLock();
    } catch {
      // Lock may already be released if the port vanished.
    }
    await withTimeout(this.port.close(), CLOSE_TIMEOUT_MS);
  }

  private async pump(): Promise<void> {
    let recoveries = 0;
    while (!this.closing) {
      const readable = this.port.readable;
      if (!readable) break;
      const reader = readable.getReader();
      this.reader = reader;
      let recovered = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            this.push(value);
            recoveries = 0;
          }
        }
      } catch (err) {
        // Non-fatal serial errors (overrun, framing) end this stream; the port
        // exposes a fresh `readable`, so loop and re-acquire. Bytes were lost,
        // so in-flight binary reads must fail. Anything else means the device is gone.
        if (isRecoverable(err) && recoveries < 50) {
          recovered = true;
          recoveries++;
          this.losses++;
          this.wakeAll();
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          this.fatal = new LinkClosedError(`The device was disconnected (${detail}).`);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Ignore: releasing an already-released lock.
        }
      }
      // A stream that simply ended is not reopened: only re-acquire after a
      // recoverable error, which is when the port hands out a fresh stream.
      if (!recovered || this.fatal) break;
    }
    if (!this.closing && !this.fatal) this.fatal = new LinkClosedError();
    this.wakeAll();
  }

  private push(chunk: Uint8Array): void {
    // Copy: some implementations reuse the chunk's buffer.
    this.queue.push(chunk.slice());
    this.buffered += chunk.length;
    this.wakeAll();
  }

  private take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const head = this.queue[0];
      const n = Math.min(head.length - this.queueHead, count - filled);
      out.set(head.subarray(this.queueHead, this.queueHead + n), filled);
      filled += n;
      this.queueHead += n;
      if (this.queueHead >= head.length) {
        this.queue.shift();
        this.queueHead = 0;
      }
    }
    this.buffered -= count;
    return out;
  }

  private wakeAll(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private assertOpen(): void {
    if (this.fatal) throw this.fatal;
    if (this.closing) throw new LinkClosedError('The link is closed');
  }

  private waitForMore(deadline: number, signal: AbortSignal | undefined, what: string): Promise<void> {
    if (signal?.aborted) return Promise.reject(new AbortedError());
    if (this.buffered === 0 && (this.fatal || this.closing)) {
      return Promise.reject(this.fatal ?? new LinkClosedError('The link is closed'));
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        this.waiters = this.waiters.filter((w) => w !== wake);
        reject(new AbortedError());
      };
      const wake = (): void => {
        cleanup();
        if (this.buffered === 0 && (this.fatal || this.closing)) {
          reject(this.fatal ?? new LinkClosedError('The link is closed'));
        } else resolve();
      };
      if (Number.isFinite(deadline)) {
        const ms = Math.max(0, deadline - Date.now());
        timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== wake);
          signal?.removeEventListener('abort', onAbort);
          reject(new TimeoutError(`Timed out waiting for ${what}`));
        }, ms);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(wake);
    });
  }
}

function deadlineFrom(timeoutMs: number | undefined): number {
  return timeoutMs === undefined || !Number.isFinite(timeoutMs) ? Infinity : Date.now() + timeoutMs;
}

/** Waits for `p` but gives up silently after `ms`; errors are swallowed. */
async function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    p.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

function isRecoverable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return ['BufferOverrunError', 'BreakError', 'FramingError', 'ParityError'].includes(err.name);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
