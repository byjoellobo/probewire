/** Shared types for capture devices. */
import type { Capture } from '../core/capture';

export type DriverKind = 'gusmanb' | 'sigrok-pico' | 'demo';

export type CapturePhase = 'configuring' | 'waiting-for-trigger' | 'transferring' | 'processing';

export interface CaptureProgress {
  readonly phase: CapturePhase;
  readonly received?: number;
  readonly total?: number;
  readonly message?: string;
}

export interface CaptureRunOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CaptureProgress) => void;
}

export interface CaptureOutcome {
  readonly capture: Capture;
  readonly warnings: readonly string[];
}

export interface DeviceSummary {
  readonly kind: DriverKind;
  /** e.g. "gusmanb PICO_2 (V6_0)". */
  readonly title: string;
  /** Short key/value facts for the device panel. */
  readonly facts: ReadonlyArray<readonly [string, string]>;
}

export interface CaptureDevice<Config> {
  readonly summary: DeviceSummary;
  capture(config: Config, options?: CaptureRunOptions): Promise<CaptureOutcome>;
  close(): Promise<void>;
}

export function formatHz(hz: number): string {
  if (hz >= 1e6) return `${trimZeros((hz / 1e6).toFixed(3))} MHz`;
  if (hz >= 1e3) return `${trimZeros((hz / 1e3).toFixed(3))} kHz`;
  return `${hz} Hz`;
}

function trimZeros(s: string): string {
  return s.replace(/\.?0+$/, '');
}
