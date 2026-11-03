/**
 * SI-prefixed rate strings in the style sigrok writes and reads them.
 *
 * Writing follows libsigrok's sr_samplerate_string: integer part, optional
 * fraction with trailing zeros stripped, a space, prefix and "Hz"
 * ("1 MHz", "12.5 MHz", "999.999 kHz"). The space matters: sigrok's parser
 * skips one character after the number, so "12.5MHz" would read as 12 Hz.
 */

const PREFIXES = ['', 'k', 'M', 'G', 'T', 'P', 'E'] as const;

export function formatSamplerate(hz: number): string {
  if (!Number.isFinite(hz) || hz < 0) throw new RangeError(`Invalid sample rate ${hz}`);
  const x = BigInt(Math.round(hz));
  let i = 0;
  let div = 1n;
  while (i < PREFIXES.length - 1 && x / div >= 1000n) {
    i++;
    div *= 1000n;
  }
  const quot = x / div;
  let fract = '';
  if (i > 0) {
    const rem = (x % div).toString().padStart(3 * i, '0');
    fract = `.${rem}`.replace(/0+$/, '').replace(/\.$/, '');
  }
  return `${quot}${fract} ${PREFIXES[i]}Hz`;
}

const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  g: 1e9,
  t: 1e12,
  p: 1e15,
  e: 1e18,
};

/**
 * Parses rate strings such as "1 MHz", "500 kHz", "12.5 MHz", "48000" or "2m".
 * More lenient than sigrok (the space is optional) since we also accept user
 * input. Returns NaN when the string is not a rate.
 */
export function parseSizeString(input: string): number {
  const m = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*([kKmMgGtTpPeE])?\s*(hz)?\s*$/i.exec(input);
  if (!m) return Number.NaN;
  const base = Number.parseFloat(m[1]);
  const mult = m[2] ? MULTIPLIERS[m[2].toLowerCase()] : 1;
  return Math.round(base * mult);
}
