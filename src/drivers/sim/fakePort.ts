/**
 * In-memory serial port with pluggable firmware. Used by the driver tests and
 * by the in-app simulated analyzers, so the real drivers run unmodified.
 */
import type { PortLike } from '../serial/link';

export interface FakeFirmware {
  /** Called for every chunk the host writes. */
  receive(bytes: Uint8Array, port: FakePort): void;
  /** Called when the host closes the port. */
  detach?(): void;
}

export class FakePort implements PortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  signals: SerialOutputSignals = {};
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private readonly firmware: FakeFirmware;
  private readonly info: Partial<SerialPortInfo>;
  private open_ = false;

  constructor(firmware: FakeFirmware, info: Partial<SerialPortInfo> = {}) {
    this.firmware = firmware;
    this.info = info;
  }

  get isOpen(): boolean {
    return this.open_;
  }

  async open(_options: SerialOptions): Promise<void> {
    if (this.open_) throw new Error('Port is already open');
    this.open_ = true;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.controller = undefined;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.open_) this.firmware.receive(chunk.slice(), this);
      },
    });
  }

  async close(): Promise<void> {
    if (!this.open_) return;
    this.open_ = false;
    try {
      this.controller?.close();
    } catch {
      // Already closed or cancelled by the reader.
    }
    this.controller = undefined;
    this.readable = null;
    this.writable = null;
    this.firmware.detach?.();
  }

  async setSignals(signals: SerialOutputSignals): Promise<void> {
    this.signals = { ...this.signals, ...signals };
  }

  getInfo(): Partial<SerialPortInfo> {
    return this.info;
  }

  /** Device -> host. Splits into chunks to mimic USB packet boundaries. */
  send(data: Uint8Array | string, chunkSize = 64): void {
    if (!this.controller) return;
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      this.controller.enqueue(bytes.slice(i, Math.min(i + chunkSize, bytes.length)));
    }
  }
}
