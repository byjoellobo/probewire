/** Formatting of times, frequencies and sizes for display. */

const TIME_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1, 's'],
  [1e-3, 'ms'],
  [1e-6, 'µs'],
  [1e-9, 'ns'],
  [1e-12, 'ps'],
];

/** "1.25 ms", "-80 µs", "0 s". `digits` = significant digits. */
export function formatDuration(seconds: number, digits = 4): string {
  if (!Number.isFinite(seconds)) return '-';
  if (seconds === 0) return '0 s';
  const abs = Math.abs(seconds);
  for (const [scale, unit] of TIME_UNITS) {
    if (abs >= scale * 0.9995 || scale === 1e-12) {
      return `${trimNumber(seconds / scale, digits)} ${unit}`;
    }
  }
  return `${seconds} s`;
}

/**
 * Formats a ruler time so that labels one `step` apart are distinguishable.
 * The unit follows `magnitude` (the largest time on screen) so a whole ruler
 * shares one unit and deep zooms read "249.9 ms" rather than "249900 µs";
 * the number of decimals follows the step.
 */
export function formatTickTime(seconds: number, step: number, magnitude = step): string {
  if (Math.abs(seconds) < step * 1e-6) return '0';
  const ref = Math.max(step, Math.abs(magnitude));
  let unitScale = 1;
  let unit = 's';
  // Switch to a unit once the reference is at least half of it: 0.5 ms reads
  // "0.5 ms" rather than "500 µs".
  for (const [scale, u] of TIME_UNITS) {
    if (ref >= scale * 0.4999) {
      unitScale = scale;
      unit = u;
      break;
    }
    unitScale = scale;
    unit = u;
  }
  const stepInUnit = step / unitScale;
  const decimals = Math.max(0, Math.ceil(-Math.log10(stepInUnit) - 1e-9));
  return `${(seconds / unitScale).toFixed(decimals)} ${unit}`;
}

export function formatFrequency(hz: number, digits = 4): string {
  if (!Number.isFinite(hz) || hz <= 0) return '-';
  if (hz >= 1e9) return `${trimNumber(hz / 1e9, digits)} GHz`;
  if (hz >= 1e6) return `${trimNumber(hz / 1e6, digits)} MHz`;
  if (hz >= 1e3) return `${trimNumber(hz / 1e3, digits)} kHz`;
  return `${trimNumber(hz, digits)} Hz`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes >= 1024 ** 3) return `${trimNumber(bytes / 1024 ** 3, 3)} GB`;
  if (bytes >= 1024 ** 2) return `${trimNumber(bytes / 1024 ** 2, 3)} MB`;
  if (bytes >= 1024) return `${trimNumber(bytes / 1024, 3)} KB`;
  return `${bytes} B`;
}

export function formatCount(n: number): string {
  if (n >= 1e9) return `${trimNumber(n / 1e9, 3)}G`;
  if (n >= 1e6) return `${trimNumber(n / 1e6, 3)}M`;
  if (n >= 1e4) return `${trimNumber(n / 1e3, 3)}k`;
  return String(n);
}

/** Rounds to `digits` significant digits and drops trailing zeros. */
export function trimNumber(value: number, digits: number): string {
  if (value === 0) return '0';
  const s = Number(value.toPrecision(digits));
  return String(s);
}
