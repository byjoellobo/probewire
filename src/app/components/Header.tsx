/** Top bar: brand, analyzer status, file and view controls, and the Capture button. */
import type { CaptureProgress } from '../../drivers/types';
import { IconClear, IconFit, IconOpen, IconPlay, IconSave, IconStop, IconZoomIn, IconZoomOut, Logo } from './icons';

interface HeaderProps {
  readonly deviceTitle?: string;
  readonly connecting: boolean;
  readonly running: boolean;
  readonly progress?: CaptureProgress;
  readonly canCapture: boolean;
  readonly captureHint?: string;
  readonly hasCapture: boolean;
  readonly hasCursors: boolean;
  readonly onDevice: () => void;
  readonly onCapture: () => void;
  readonly onStop: () => void;
  readonly onOpen: () => void;
  readonly onSave: () => void;
  readonly onZoom: (factor: number) => void;
  readonly onFit: () => void;
  readonly onClearCursors: () => void;
}

export function Header(p: HeaderProps) {
  const pct = p.progress?.total ? Math.min(100, ((p.progress.received ?? 0) / p.progress.total) * 100) : 0;
  return (
    <header class="header">
      <div class="brand">
        <Logo />
        <h1 class="wordmark">Probewire</h1>
      </div>
      <button type="button" class="device-pill" onClick={p.onDevice} title="Analyzer settings">
        <span class={`dot${p.running || p.connecting ? ' busy' : p.deviceTitle ? ' on' : ''}`} />
        <span>{p.connecting ? 'Connecting...' : (p.deviceTitle ?? 'No analyzer')}</span>
      </button>
      <div class="spacer" />
      <div class="toolbar">
        <button type="button" class="icon-btn" title="Open .sr file" onClick={p.onOpen}>
          <IconOpen />
        </button>
        <button type="button" class="icon-btn" title="Save as .sr file for PulseView" onClick={p.onSave} disabled={!p.hasCapture}>
          <IconSave />
        </button>
        <span class="sep desktop-only" />
        <span class="desktop-only toolbar">
          <button type="button" class="icon-btn" title="Zoom out (-)" onClick={() => p.onZoom(2)} disabled={!p.hasCapture}>
            <IconZoomOut />
          </button>
          <button type="button" class="icon-btn" title="Zoom in (+)" onClick={() => p.onZoom(0.5)} disabled={!p.hasCapture}>
            <IconZoomIn />
          </button>
        </span>
        {/* Fit stays on phones too: pinch can zoom in, but getting back out should take one tap. */}
        <button type="button" class="icon-btn" title="Show the whole capture (F)" onClick={p.onFit} disabled={!p.hasCapture}>
          <IconFit />
        </button>
        <span class="desktop-only toolbar">
          <button type="button" class="icon-btn" title="Clear cursors" onClick={p.onClearCursors} disabled={!p.hasCursors}>
            <IconClear />
          </button>
          <span class="sep" />
        </span>
        {p.running ? (
          <button type="button" class="btn stop capture-btn" onClick={p.onStop}>
            <IconStop size={14} /> Stop
            <span class="progress" style={{ width: `${pct}%` }} />
          </button>
        ) : (
          <button type="button" class="btn primary capture-btn" onClick={p.onCapture} disabled={!p.canCapture} title={p.captureHint}>
            <IconPlay size={14} /> Capture
          </button>
        )}
      </div>
    </header>
  );
}
