/** First screen: what this is, and three ways in. */
import type { BackendSupport } from '../../drivers/serial/ports';
import { IconOpen, IconPlay } from './icons';

interface EmptyStateProps {
  readonly support: BackendSupport;
  readonly onDemo: () => void;
  readonly onConnect: () => void;
  readonly onOpen: () => void;
  readonly busy: boolean;
  /** Most recent capture in the library, offered for reopening. */
  readonly recent?: { readonly name: string; readonly onReopen: () => void };
}

const BIT = 19;
const HI = 22;
const LO = 58;
const X0 = 18;

/** UART 8N1 frames for `bytes`, LSB first, as an SVG path plus byte spans. */
function uartPath(bytes: readonly number[]): { d: string; spans: Array<{ x0: number; x1: number; byte: number }>; end: number } {
  let x = X0;
  let level = 1;
  let d = `M0 ${HI} H${x}`;
  const spans: Array<{ x0: number; x1: number; byte: number }> = [];
  const step = (bit: number): void => {
    if (bit !== level) {
      d += ` V${bit ? HI : LO}`;
      level = bit;
    }
    x += BIT;
    d += ` H${x}`;
  };
  for (const byte of bytes) {
    step(0);
    const x0 = x;
    for (let i = 0; i < 8; i++) step((byte >> i) & 1);
    spans.push({ x0, x1: x, byte });
    step(1);
    x += BIT * 0.6;
    d += ` H${x}`;
  }
  return { d, spans, end: x };
}

export function EmptyState({ support, onDemo, onConnect, onOpen, busy, recent }: EmptyStateProps) {
  const { d, spans, end } = uartPath([0x4f, 0x4b, 0x0a]);
  const width = end + 24;
  const usb = support.webSerial || support.webUsb;
  return (
    <div class="empty">
      <div class="empty-inner">
        <svg class="hero-wave" viewBox={`0 0 ${width} 104`} role="img" aria-label="A UART signal decoding to the text OK">
          <path class="wave" d={`${d} H${width}`} stroke="#5dc26a" />
          {spans.map((s, i) => {
            const mid = (s.x0 + s.x1) / 2;
            const label = s.byte === 0x0a ? '\\n' : `'${String.fromCharCode(s.byte)}'`;
            return (
              <g key={s.x0} class="ann" style={{ animationDelay: `${1.1 + i * 0.18}s` }}>
                <path
                  d={`M${s.x0} 84 L${s.x0 + 6} 72 H${s.x1 - 6} L${s.x1} 84 L${s.x1 - 6} 96 H${s.x0 + 6} Z`}
                  fill="rgba(111, 183, 217, 0.18)"
                  stroke="#6fb7d9"
                />
                <text x={mid} y={88} text-anchor="middle" fill="#e6ebe3" font-size="15" font-weight="600">
                  {label} 0x{s.byte.toString(16).toUpperCase().padStart(2, '0')}
                </text>
              </g>
            );
          })}
        </svg>
        <h2>A logic analyzer that runs in a browser tab.</h2>
        <p>
          Plug in a Raspberry Pi Pico running the gusmanb or sigrok-pico firmware, capture up to 24 channels, and decode UART, I2C and SPI. Captures
          stay on this device and open in PulseView as .sr files.
        </p>
        <div class="actions">
          <button type="button" class="btn primary" onClick={onDemo} disabled={busy}>
            <IconPlay size={16} /> Try a demo capture
          </button>
          <button type="button" class="btn" onClick={onConnect}>
            Connect an analyzer
          </button>
          <button type="button" class="btn" onClick={onOpen}>
            <IconOpen size={18} /> Open .sr file
          </button>
          {recent && (
            <button type="button" class="btn quiet" onClick={recent.onReopen} title={recent.name}>
              Reopen last capture
            </button>
          )}
        </div>
        {!usb && (
          <p class="support-note">
            This browser cannot talk to USB devices. Use Chrome or Edge on a computer, or Chrome on Android, to connect an analyzer. The demo and .sr
            files work everywhere.
          </p>
        )}
      </div>
    </div>
  );
}
