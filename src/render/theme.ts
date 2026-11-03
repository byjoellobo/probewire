/**
 * Visual tokens shared by the canvas renderer and CSS (styles.css mirrors these).
 * Palette: solder-mask green board, silkscreen text, ENIG-gold for things you
 * grab or measure, and probe-wire colours (resistor colour code) for channels.
 */
import type { AnnotationKind } from '../decoders/types';

export const THEME = {
  mask: '#0f1d1b',
  board: '#152724',
  boardRaised: '#1b302c',
  trace: '#24403b',
  traceStrong: '#335a52',
  silk: '#e6ebe3',
  silkDim: '#8fa39c',
  silkFaint: '#53675f',
  gold: '#d9ae4e',
  goldSoft: 'rgba(217, 174, 78, 0.10)',
  grid: 'rgba(143, 163, 156, 0.10)',
  gridMajor: 'rgba(143, 163, 156, 0.20)',
  burst: '#a77be0',
  font: '"Barlow Semi Condensed", "Barlow", system-ui, sans-serif',
} as const;

/**
 * Probe-wire colours in resistor colour-code order (black, brown, red, orange,
 * yellow, green, blue, violet, grey, white), tuned to read on the dark board.
 * "Black" is drawn as a cool light grey so it stays visible.
 */
export const WIRE_COLORS = ['#b8c2c6', '#c08a5c', '#e5534b', '#f08c3a', '#e8d44d', '#5dc26a', '#4c9be8', '#a77be0', '#7f8a8f', '#f4f4ee'] as const;

/** The colour of the physical wire, for the label swatch. */
export const WIRE_SWATCH = ['#1c1c1c', '#7a4a26', '#d42f2f', '#ef7a1a', '#f2d22e', '#2f9e44', '#1f6fd1', '#7b4bc4', '#8a8f93', '#f5f5f0'] as const;

export function channelColor(index: number): string {
  return WIRE_COLORS[index % WIRE_COLORS.length];
}

export function channelSwatch(index: number): string {
  return WIRE_SWATCH[index % WIRE_SWATCH.length];
}

export const ANALOG_COLORS = ['#7fd3c4', '#f2a5c0', '#c3d97a'] as const;

export const ANNOTATION_COLORS: Record<AnnotationKind, string> = {
  data: '#6fb7d9',
  address: '#e3a15e',
  control: '#8bcb7a',
  ack: '#5faf8f',
  nack: '#e07a5f',
  bit: '#7d8f8a',
  summary: '#b39ddb',
  warning: '#e8c547',
  error: '#f25f5c',
};

/** Decoder accent colours, one per decoder instance. */
export const DECODER_ACCENTS = ['#6fb7d9', '#b39ddb', '#8bcb7a', '#e3a15e', '#f2a5c0'] as const;
