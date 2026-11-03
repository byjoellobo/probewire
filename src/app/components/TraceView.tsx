/**
 * Waveform view: row labels, time ruler and the trace canvas.
 *
 * The viewport lives in a ref and the canvases are redrawn imperatively on
 * animation frames, so panning and zooming never re-render the component tree.
 * Gestures: drag to pan, pinch or wheel to zoom, tap/hover to probe, tap or
 * drag on the ruler to place cursors A and B.
 */
import type { Ref } from 'preact';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Annotation } from '../../decoders/types';
import { drawRuler, drawTraces, type TraceRow } from '../../render/draw';
import { centerOn, clampViewport, fitViewport, panBy, sampleToX, xToSample, zoomAt, zoomToRange, type Viewport } from '../../render/viewport';
import type { Workspace } from '../workspace';

export interface RowSpec {
  readonly key: string;
  readonly label: string;
  readonly swatch: string;
  readonly height: number;
  readonly trace: TraceRow;
  /** Logic channel bit index, for renaming. */
  readonly channel?: number;
  readonly title?: string;
  /** Short owner tag shown before the label, e.g. the decoder name on decoder rows. */
  readonly tag?: string;
  /** First row of a new group (decoder rows after channel rows). */
  readonly groupStart?: boolean;
}

export interface Cursors {
  readonly a?: number;
  readonly b?: number;
}

export interface Probe {
  readonly sample: number;
  readonly rowKey?: string;
}

export interface TraceViewHandle {
  fit(): void;
  zoom(factor: number): void;
  /** Shows [start, end) or centres on `start` when `end` is omitted. */
  goTo(start: number, end?: number): void;
  visibleRange(): readonly [number, number];
}

interface TraceViewProps {
  readonly ws: Workspace;
  readonly rows: readonly RowSpec[];
  readonly cursors: Cursors;
  readonly onCursors: (c: Cursors) => void;
  readonly probe?: Probe;
  readonly onProbe: (p: Probe | undefined) => void;
  readonly selected?: Annotation;
  readonly onRename: (channel: number, name: string) => void;
  readonly handleRef: Ref<TraceViewHandle>;
}

interface Gesture {
  pointers: Map<number, { x: number; y: number }>;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  axis?: 'x' | 'y';
  pinch?: { dist: number; midX: number; vp: Viewport };
}

const TAP_SLOP = 6;

export function TraceView({ ws, rows, cursors, onCursors, probe, onProbe, selected, onRename, handleRef }: TraceViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tracesRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const vpRef = useRef<Viewport>({ start: 0, spp: 1 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const frameRef = useRef(0);
  const gestureRef = useRef<Gesture | undefined>(undefined);
  const cursorDragRef = useRef<'a' | 'b' | undefined>(undefined);
  const propsRef = useRef({ ws, rows, cursors, probe, selected });
  propsRef.current = { ws, rows, cursors, probe, selected };
  const [editing, setEditing] = useState<string | undefined>(undefined);

  const count = ws.capture.sampleCount;
  const totalHeight = rows.reduce((h, r) => h + r.height, 0);

  const paint = useCallback(() => {
    frameRef.current = 0;
    const canvas = canvasRef.current;
    const ruler = rulerRef.current;
    const scroller = scrollRef.current;
    if (!canvas || !ruler || !scroller) return;
    const { width, height } = sizeRef.current;
    if (width <= 0 || height <= 0) return;
    const p = propsRef.current;
    const dpr = window.devicePixelRatio || 1;
    const v = vpRef.current;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawTraces(ctx, {
        width,
        height,
        scrollTop: scroller.scrollTop,
        viewport: v,
        sampleCount: p.ws.capture.sampleCount,
        sampleRate: p.ws.capture.sampleRate,
        pyramid: p.ws.pyramid,
        rows: p.rows.map((r) => r.trace),
        cursorA: p.cursors.a,
        cursorB: p.cursors.b,
        triggerSample: p.ws.capture.triggerSample,
        burstStarts: p.ws.capture.burstStarts,
        probeSample: p.probe?.sample,
        selected: p.selected,
      });
    }
    const rctx = ruler.getContext('2d');
    if (rctx) {
      rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRuler(rctx, {
        width,
        height: ruler.clientHeight,
        viewport: v,
        sampleRate: p.ws.capture.sampleRate,
        originSample: p.ws.capture.triggerSample ?? 0,
        cursorA: p.cursors.a,
        cursorB: p.cursors.b,
        triggerSample: p.ws.capture.triggerSample,
      });
    }
  }, []);

  const schedule = useCallback(() => {
    if (!frameRef.current) frameRef.current = requestAnimationFrame(paint);
  }, [paint]);

  const setViewport = useCallback(
    (v: Viewport) => {
      vpRef.current = clampViewport(v, propsRef.current.ws.capture.sampleCount, sizeRef.current.width);
      schedule();
    },
    [schedule],
  );

  // Canvas sizing follows the layout.
  useLayoutEffect(() => {
    const traces = tracesRef.current;
    const scroller = scrollRef.current;
    const canvas = canvasRef.current;
    const ruler = rulerRef.current;
    if (!traces || !scroller || !canvas || !ruler) return;
    const resize = (): void => {
      const width = Math.max(1, Math.floor(traces.clientWidth));
      const height = Math.max(1, Math.min(scroller.clientHeight, Math.max(totalHeight, 1)));
      const dpr = window.devicePixelRatio || 1;
      const prevWidth = sizeRef.current.width;
      sizeRef.current = { width, height };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ruler.width = Math.round(ruler.clientWidth * dpr);
      ruler.height = Math.round(ruler.clientHeight * dpr);
      // Keep the same time span visible when the width changes.
      const v = vpRef.current;
      if (prevWidth > 0 && prevWidth !== width) vpRef.current = clampViewport({ start: v.start, spp: (v.spp * prevWidth) / width }, count, width);
      paint();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(traces);
    ro.observe(scroller);
    resize();
    return () => ro.disconnect();
  }, [totalHeight, count, paint]);

  // New capture: show all of it.
  useLayoutEffect(() => {
    vpRef.current = fitViewport(ws.capture.sampleCount, Math.max(1, sizeRef.current.width));
    schedule();
  }, [ws.capture.id, ws.capture.sampleCount, schedule]);

  useEffect(schedule, [rows, cursors, probe, selected, ws, schedule]);

  useImperativeHandle(
    handleRef,
    () => ({
      fit: () => setViewport(fitViewport(propsRef.current.ws.capture.sampleCount, sizeRef.current.width)),
      zoom: (factor: number) => {
        const { width } = sizeRef.current;
        setViewport(zoomAt(vpRef.current, factor, width / 2, propsRef.current.ws.capture.sampleCount, width));
      },
      goTo: (start: number, end?: number) => {
        const n = propsRef.current.ws.capture.sampleCount;
        const { width } = sizeRef.current;
        if (end === undefined) setViewport(centerOn(vpRef.current, start, n, width));
        else {
          const v = vpRef.current;
          const visible = width * v.spp;
          // Keep the zoom if the range already fits comfortably; otherwise zoom to it.
          if (end - start < visible * 0.9 && end - start > visible * 0.01) setViewport(centerOn(v, (start + end) / 2, n, width));
          else setViewport(zoomToRange(start, end, n, width));
        }
      },
      visibleRange: () => {
        const v = vpRef.current;
        return [v.start, xToSample(v, sizeRef.current.width)] as const;
      },
    }),
    [setViewport],
  );

  const rowAt = (y: number): string | undefined => {
    const scroller = scrollRef.current;
    let top = -(scroller?.scrollTop ?? 0);
    for (const r of propsRef.current.rows) {
      if (y >= top && y < top + r.height) return r.key;
      top += r.height;
    }
    return undefined;
  };

  const localPoint = (e: PointerEvent | WheelEvent | MouseEvent, el: HTMLElement): { x: number; y: number } => {
    const rect = el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // Wheel needs a non-passive listener to stop page scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ruler = rulerRef.current;
    if (!canvas || !ruler) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const { x } = localPoint(e, canvas);
      const { width } = sizeRef.current;
      const n = propsRef.current.ws.capture.sampleCount;
      const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (horizontal && !e.ctrlKey) {
        const d = (e.shiftKey ? e.deltaY : e.deltaX) * scale;
        setViewport(panBy(vpRef.current, -d, n, width));
      } else {
        setViewport(zoomAt(vpRef.current, Math.exp(e.deltaY * scale * 0.0018), x, n, width));
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    ruler.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      ruler.removeEventListener('wheel', onWheel);
    };
  }, [setViewport]);

  const onPointerDown = (e: PointerEvent): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const pt = localPoint(e, canvas);
    const g: Gesture = gestureRef.current ?? { pointers: new Map(), startX: pt.x, startY: pt.y, lastX: pt.x, lastY: pt.y, moved: false };
    g.pointers.set(e.pointerId, pt);
    if (g.pointers.size === 1) {
      Object.assign(g, { startX: pt.x, startY: pt.y, lastX: pt.x, lastY: pt.y, moved: false, axis: undefined, pinch: undefined });
    } else if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      g.pinch = { dist: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), midX: (a.x + b.x) / 2, vp: vpRef.current };
      g.moved = true;
    }
    gestureRef.current = g;
    canvas.classList.add('dragging');
  };

  const onPointerMove = (e: PointerEvent): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pt = localPoint(e, canvas);
    const g = gestureRef.current;
    const n = propsRef.current.ws.capture.sampleCount;
    const { width } = sizeRef.current;
    if (!g || !g.pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') onProbe({ sample: xToSample(vpRef.current, pt.x), rowKey: rowAt(pt.y) });
      return;
    }
    g.pointers.set(e.pointerId, pt);
    if (g.pinch && g.pointers.size >= 2) {
      const [a, b] = [...g.pointers.values()];
      const dist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const midX = (a.x + b.x) / 2;
      const zoomed = zoomAt(g.pinch.vp, g.pinch.dist / dist, g.pinch.midX, n, width);
      setViewport(panBy(zoomed, midX - g.pinch.midX, n, width));
      return;
    }
    const dx = pt.x - g.lastX;
    const dy = pt.y - g.lastY;
    g.lastX = pt.x;
    g.lastY = pt.y;
    if (!g.moved && Math.hypot(pt.x - g.startX, pt.y - g.startY) > TAP_SLOP) {
      g.moved = true;
      g.axis = e.pointerType === 'touch' && Math.abs(pt.y - g.startY) > Math.abs(pt.x - g.startX) ? 'y' : 'x';
    }
    if (!g.moved) return;
    if (g.axis === 'y') {
      if (scrollRef.current) scrollRef.current.scrollTop -= dy;
    } else {
      setViewport(panBy(vpRef.current, dx, n, width));
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    const canvas = canvasRef.current;
    const g = gestureRef.current;
    if (!canvas || !g) return;
    const pt = localPoint(e, canvas);
    if (!g.moved && g.pointers.size === 1) onProbe({ sample: xToSample(vpRef.current, pt.x), rowKey: rowAt(pt.y) });
    g.pointers.delete(e.pointerId);
    if (g.pointers.size < 2) g.pinch = undefined;
    if (g.pointers.size === 0) {
      gestureRef.current = undefined;
      canvas.classList.remove('dragging');
    } else {
      const [rest] = [...g.pointers.values()];
      g.lastX = rest.x;
      g.lastY = rest.y;
    }
  };

  const onDoubleClick = (e: MouseEvent): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x } = localPoint(e, canvas);
    setViewport(zoomAt(vpRef.current, e.shiftKey ? 2 : 0.5, x, count, sizeRef.current.width));
  };

  // Ruler: place or drag cursors.
  const nearestCursor = (x: number): 'a' | 'b' | undefined => {
    const c = propsRef.current.cursors;
    const v = vpRef.current;
    const da = c.a === undefined ? Infinity : Math.abs(sampleToX(v, c.a) - x);
    const db = c.b === undefined ? Infinity : Math.abs(sampleToX(v, c.b) - x);
    if (Math.min(da, db) > 14) return undefined;
    return da <= db ? 'a' : 'b';
  };

  const snap = (x: number): number => Math.max(0, Math.min(count, Math.round(xToSample(vpRef.current, x))));

  const onRulerDown = (e: PointerEvent): void => {
    const ruler = rulerRef.current;
    if (!ruler) return;
    ruler.setPointerCapture(e.pointerId);
    const { x } = localPoint(e, ruler);
    const c = propsRef.current.cursors;
    let which = nearestCursor(x);
    if (!which) {
      if (c.a === undefined) which = 'a';
      else if (c.b === undefined) which = 'b';
      else which = Math.abs(sampleToX(vpRef.current, c.a) - x) < Math.abs(sampleToX(vpRef.current, c.b) - x) ? 'a' : 'b';
      const next = { ...c, [which]: snap(x) };
      // Keep the local copy current so rapid taps see this cursor before the next render.
      propsRef.current = { ...propsRef.current, cursors: next };
      onCursors(next);
    }
    cursorDragRef.current = which;
  };

  const onRulerMove = (e: PointerEvent): void => {
    const which = cursorDragRef.current;
    const ruler = rulerRef.current;
    if (!which || !ruler) return;
    const { x } = localPoint(e, ruler);
    const next = { ...propsRef.current.cursors, [which]: snap(x) };
    propsRef.current = { ...propsRef.current, cursors: next };
    onCursors(next);
  };

  const onRulerUp = (): void => {
    cursorDragRef.current = undefined;
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // Leave typing in the rename box and browser shortcuts (Ctrl+F, Ctrl+0) alone.
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    const { width } = sizeRef.current;
    const v = vpRef.current;
    const handled = (() => {
      switch (e.key) {
        case 'ArrowLeft':
          setViewport(panBy(v, width / 6, count, width));
          return true;
        case 'ArrowRight':
          setViewport(panBy(v, -width / 6, count, width));
          return true;
        case '+':
        case '=':
          setViewport(zoomAt(v, 0.5, width / 2, count, width));
          return true;
        case '-':
        case '_':
          setViewport(zoomAt(v, 2, width / 2, count, width));
          return true;
        case '0':
        case 'f':
          setViewport(fitViewport(count, width));
          return true;
        case 'a':
        case 'b': {
          // Keyboard measuring: drop cursor A or B at the centre of the view.
          const centre = Math.max(0, Math.min(count, Math.round(xToSample(v, width / 2))));
          const next = { ...propsRef.current.cursors, [e.key]: centre };
          propsRef.current = { ...propsRef.current, cursors: next };
          onCursors(next);
          return true;
        }
        case 'x':
          propsRef.current = { ...propsRef.current, cursors: {} };
          onCursors({});
          return true;
        case 'Home':
          setViewport({ start: 0, spp: v.spp });
          return true;
        case 'End':
          setViewport({ start: count, spp: v.spp });
          return true;
        default:
          return false;
      }
    })();
    if (handled) e.preventDefault();
  };

  return (
    <div class="traceview">
      <div class="ruler">
        <div class="corner">{ws.capture.triggerSample !== undefined ? 'From trigger' : 'From start'}</div>
        <canvas
          ref={rulerRef}
          aria-label="Time ruler. Click or tap to place cursors A and B; drag a cursor to move it."
          onPointerDown={onRulerDown}
          onPointerMove={onRulerMove}
          onPointerUp={onRulerUp}
          onPointerCancel={onRulerUp}
        />
      </div>
      <div
        class="rows"
        ref={scrollRef}
        tabIndex={0}
        onScroll={schedule}
        onKeyDown={onKeyDown}
        id="waveform"
        aria-label="Waveforms. Arrow keys pan, plus and minus zoom, F fits, A and B place cursors at the centre, X clears them."
      >
        <div class="rows-inner" style={{ height: `${totalHeight}px` }}>
          <div class="labels">
            {rows.map((r) => (
              <RowLabel
                key={r.key}
                row={r}
                editing={editing === r.key}
                onEdit={() => setEditing(r.key)}
                onDone={(name) => {
                  setEditing(undefined);
                  if (name !== undefined && r.channel !== undefined) onRename(r.channel, name);
                }}
              />
            ))}
          </div>
          <div class="traces" ref={tracesRef}>
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={(e) => {
                if (e.pointerType === 'mouse' && !gestureRef.current) onProbe(undefined);
              }}
              onDblClick={onDoubleClick}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

interface RowLabelProps {
  readonly row: RowSpec;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onDone: (name?: string) => void;
}

function RowLabel({ row, editing, onEdit, onDone }: RowLabelProps) {
  const isDecoder = row.trace.kind === 'decoder';
  const style = { height: `${row.height}px`, '--wire': row.swatch } as Record<string, string>;
  // Escape unmounts the input, which fires blur; the guard stops that blur from committing.
  const finished = useRef(false);
  const finish = (name?: string): void => {
    if (finished.current) return;
    finished.current = true;
    onDone(name);
  };
  return (
    <div class={`label${isDecoder ? ' decoder-row' : ''}${row.groupStart ? ' group-start' : ''}`} style={style} title={row.title ?? row.label}>
      <span class="swatch" />
      {row.tag && <span class="tag">{row.tag}</span>}
      {editing ? (
        <input
          aria-label={`New name for ${row.label}`}
          defaultValue={row.label}
          maxLength={32}
          ref={(el) => {
            if (el && !finished.current && document.activeElement !== el) el.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finish((e.currentTarget as HTMLInputElement).value.trim() || row.label);
            if (e.key === 'Escape') finish(undefined);
          }}
          onBlur={(e) => finish((e.currentTarget as HTMLInputElement).value.trim() || row.label)}
        />
      ) : row.channel !== undefined ? (
        <button
          class="name"
          type="button"
          onClick={() => {
            finished.current = false;
            onEdit();
          }}
          aria-label={`Rename ${row.label}`}
        >
          {row.label}
        </button>
      ) : (
        <span class="name">{row.label}</span>
      )}
    </div>
  );
}
