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
  /** Why Capture is unavailable, shown where the eye looks after pressing it. */
  readonly blockedReason?: string;
  /** True on touch-first devices, so hints say "tap" rather than "click". */
  readonly coarsePointer: boolean;
}

const PHASE_TEXT: Record<CaptureProgress['phase'], string> = {
  configuring: 'Configuring the analyzer',
  'waiting-for-trigger': 'Waiting for the trigger',
  transferring: 'Receiving samples',
  processing: 'Processing',
};

function phaseText(progress: CaptureProgress): string {
  const pct = progress.total ? ` ${Math.floor(((progress.received ?? 0) / progress.total) * 100)}%` : '';
  return `${progress.message ?? PHASE_TEXT[progress.phase]}${pct}`;
}

export function StatusBar({ capture, cursors, readout, progress, blockedReason, coarsePointer }: StatusBarProps) {
  const rate = capture?.sampleRate ?? 1;
  const origin = capture?.triggerSample ?? 0;
  const t = (s: number): string => formatDuration((s - origin) / rate, 5);
  const delta = cursors.a !== undefined && cursors.b !== undefined ? Math.abs(cursors.b - cursors.a) / rate : undefined;
  const deltaText = delta !== undefined ? `${formatDuration(delta, 5)}${delta > 0 ? `, ${formatFrequency(1 / delta)}` : ''}` : undefined;
  const verb = coarsePointer ? 'Tap' : 'Click';
  const hint = capture && cursors.a === undefined && !progress ? `${verb} the ruler to place cursors. ${verb} a trace to measure it.` : '';
  // Announce only meaningful changes: the capture phase and a completed A-B measurement.
  // The hover readout changes on every pointer move and stays out of the live region.
  const announcement = progress ? PHASE_TEXT[progress.phase] : deltaText ? `Cursor A to B: ${deltaText}` : '';
  return (
    <footer class="status">
      <span class="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {progress ? (
        <span class="gold">{phaseText(progress)}</span>
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
      <span class="grow">{readout ?? (blockedReason && !progress ? <span class="blocked">Capture unavailable: {blockedReason}</span> : hint)}</span>
      {capture && (
        <span class="wide">
          {formatFrequency(capture.sampleRate)}, {formatCount(capture.sampleCount)} samples,{' '}
          {formatDuration(capture.sampleCount / capture.sampleRate, 3)}
        </span>
      )}
    </footer>
  );
}
