/** Bottom bar: cursor measurements, probe readout and capture facts. */
import type { Capture } from '../../core/capture';
import { formatCount, formatDuration, formatFrequency } from '../../core/units';
import type { CaptureProgress } from '../../drivers/types';
import type { Cursors } from './TraceView';

interface StatusBarProps {
  readonly capture?: Capture;
  readonly cursors: Cursors;
  readonly readout?: string;
  readonly progress?: CaptureProgress;
}

const PHASE_TEXT: Record<CaptureProgress['phase'], string> = {
  configuring: 'Configuring the analyzer',
  'waiting-for-trigger': 'Waiting for the trigger',
  transferring: 'Receiving samples',
  processing: 'Processing',
};

export function StatusBar({ capture, cursors, readout, progress }: StatusBarProps) {
  const rate = capture?.sampleRate ?? 1;
  const origin = capture?.triggerSample ?? 0;
  const t = (s: number): string => formatDuration((s - origin) / rate, 5);
  const delta = cursors.a !== undefined && cursors.b !== undefined ? Math.abs(cursors.b - cursors.a) / rate : undefined;
  return (
    <footer class="status" aria-live="polite">
      {progress ? (
        <span class="gold">
          {progress.message ?? PHASE_TEXT[progress.phase]}
          {progress.total ? ` ${Math.floor(((progress.received ?? 0) / progress.total) * 100)}%` : ''}
        </span>
      ) : (
        <>
          {cursors.a !== undefined && (
            <span>
              A <strong>{t(cursors.a)}</strong>
            </span>
          )}
          {cursors.b !== undefined && (
            <span>
              B <strong>{t(cursors.b)}</strong>
            </span>
          )}
          {delta !== undefined && (
            <span class="gold">
              Δ <strong class="gold">{formatDuration(delta, 5)}</strong> {delta > 0 ? formatFrequency(1 / delta) : ''}
            </span>
          )}
        </>
      )}
      <span class="grow">{readout ?? (capture && cursors.a === undefined && !progress ? 'Tap the ruler to place cursors. Tap a trace to measure it.' : '')}</span>
      {capture && (
        <span class="wide">
          {formatFrequency(capture.sampleRate)}, {formatCount(capture.sampleCount)} samples, {formatDuration(capture.sampleCount / capture.sampleRate, 3)}
        </span>
      )}
    </footer>
  );
}
