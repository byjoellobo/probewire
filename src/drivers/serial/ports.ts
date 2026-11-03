/**
 * Picking a serial port.
 *
 * Two backends:
 *  - 'web-serial': navigator.serial. Desktop Chrome/Edge/Opera, Firefox 151+,
 *    and Chrome 148+ on Android 17+.
 *  - 'webusb': the web-serial-polyfill driving the device's CDC-ACM interface
 *    over WebUSB. The fallback for Android phones without wired Web Serial.
 *
 * Feature detection cannot tell whether wired serial works on Android
 * ('serial' exists on Chrome 138+ for Bluetooth only), so the UI offers both.
 */
import type { PortLike } from './link';

export type SerialBackend = 'web-serial' | 'webusb';

export interface PortFilter {
  usbVendorId: number;
  usbProductId?: number;
}

export interface BackendSupport {
  readonly webSerial: boolean;
  readonly webUsb: boolean;
  readonly secureContext: boolean;
  readonly likelyMobile: boolean;
}

export function detectSupport(): BackendSupport {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    webSerial: !!nav && 'serial' in nav,
    webUsb: !!nav && 'usb' in nav,
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
    likelyMobile: !!nav && /Android|Mobile/i.test(nav.userAgent),
  };
}

/** Must be called from a user gesture (click/tap). */
export async function requestPort(backend: SerialBackend, filters: readonly PortFilter[]): Promise<PortLike> {
  const f = filters.map((x) => ({ ...x }));
  if (backend === 'web-serial') {
    if (!('serial' in navigator)) throw new Error('This browser has no Web Serial support. Try Chrome or Edge, or the USB compatibility mode.');
    return navigator.serial.requestPort(f.length > 0 ? { filters: f } : {});
  }
  if (!('usb' in navigator)) throw new Error('This browser has no WebUSB support.');
  const { serial } = await import('web-serial-polyfill');
  return serial.requestPort(f.length > 0 ? { filters: f } : {}) as unknown as Promise<PortLike>;
}

/** Ports the user has already granted, for reconnecting without a prompt. */
export async function grantedPorts(backend: SerialBackend): Promise<PortLike[]> {
  try {
    if (backend === 'web-serial') {
      if (!('serial' in navigator)) return [];
      return await navigator.serial.getPorts();
    }
    if (!('usb' in navigator)) return [];
    const { serial } = await import('web-serial-polyfill');
    return (await serial.getPorts()) as unknown as PortLike[];
  } catch {
    return [];
  }
}

export function describePort(port: PortLike): string {
  const info = port.getInfo?.() ?? {};
  if (info.usbVendorId === undefined) return 'Serial port';
  const hex4 = (n: number): string => n.toString(16).padStart(4, '0').toUpperCase();
  return `USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId ?? 0)}`;
}

/** Recommended open() buffer size per backend: large buffers keep up with bulk capture data. */
export function bufferSizeFor(backend: SerialBackend): number {
  return backend === 'web-serial' ? 1 << 20 : 1 << 16;
}
