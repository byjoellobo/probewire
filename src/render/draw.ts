/**
 * Canvas rendering of logic, analog and decoder rows, plus the time ruler.
 *
 * Cost per frame is proportional to the canvas width, not the capture size:
 * for each pixel column we take the OR/AND of the covered samples from the
 * LogicPyramid once, and every logic row reads its bit from those words.
 */
import type { AnalogPyramid, LogicPyramid } from '../core/pyramid';
import type { Annotation } from '../decoders/types';
import { ANNOTATION_COLORS, THEME } from './theme';
import { sampleToX, timeTicks, type Viewport } from './viewport';

export type TraceRow =
  | { readonly kind: 'logic'; readonly key: string; readonly channel: number; readonly color: string; readonly height: number }
  | {
      readonly kind: 'analog';
      readonly key: string;
      readonly pyramid: AnalogPyramid;
      readonly color: string;
      readonly height: number;
      readonly unit: string;
    }
  | {
      readonly kind: 'decoder';
      readonly key: string;
      readonly annotations: readonly Annotation[];
      readonly color: string;
      readonly height: number;
      /** Draw a heavier rule above this row (first decoder row). */
      readonly groupStart?: boolean;
    };

export interface Scene {
  readonly width: number;
  readonly height: number;
  /** Vertical scroll offset of the row list; rows are drawn shifted up by this. */
  readonly scrollTop: number;
  readonly viewport: Viewport;
  readonly sampleCount: number;
  readonly sampleRate: number;
  readonly pyramid: LogicPyramid;
  readonly rows: readonly TraceRow[];
  readonly cursorA?: number;
  readonly cursorB?: number;
  readonly triggerSample?: number;
  readonly burstStarts?: readonly number[];
  readonly probeSample?: number;
  /** Annotation to outline, e.g. one picked from the results table. */
  readonly selected?: Annotation;
}

interface Columns {
  readonly or: Uint32Array;
  readonly and: Uint32Array;
  readonly valid: number;
}

const agg = { or: 0, and: 0 };

/** Per-column OR/AND words for the current viewport (only used when spp >= 1). */
function columnWords(scene: Scene): Columns {
  const { width, viewport: v, pyramid, sampleCount } = scene;
  const or = new Uint32Array(width);
  const and = new Uint32Array(width);
  let valid = 0;
  for (let x = 0; x < width; x++) {
    const s0 = Math.floor(v.start + x * v.spp);
    if (s0 >= sampleCount) break;
    const s1 = Math.min(sampleCount, Math.max(s0 + 1, Math.floor(v.start + (x + 1) * v.spp)));
    pyramid.aggregate(s0, s1, agg);
    or[x] = agg.or;
    and[x] = agg.and;
    valid = x + 1;
  }
  return { or, and, valid };
}

export function drawTraces(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { width, height } = scene;
  ctx.fillStyle = THEME.mask;
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, scene);
  drawCursorBand(ctx, scene);

  const zoomedIn = scene.viewport.spp < 1;
  const cols = zoomedIn ? undefined : columnWords(scene);
  let top = -scene.scrollTop;
  for (const row of scene.rows) {
    if (top + row.height <= 0) {
      top += row.height;
      continue;
    }
    if (top >= height) break;
    if (row.kind === 'logic') {
      if (cols) drawLogicColumns(ctx, row, top, cols);
      else drawLogicSamples(ctx, scene, row, top);
    } else if (row.kind === 'analog') {
      drawAnalog(ctx, scene, row, top);
    } else {
      drawAnnotations(ctx, scene, row, top);
    }
    ctx.fillStyle = THEME.trace;
    ctx.fillRect(0, top + row.height - 1, width, 1);
    if (row.kind === 'decoder' && row.groupStart) {
      ctx.fillStyle = THEME.traceStrong;
      ctx.fillRect(0, top, width, 2);
    }
    top += row.height;
  }
  drawMarkers(ctx, scene, height);
}

function drawGrid(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const ticks = timeTicks(scene.viewport, scene.width, scene.sampleRate, scene.triggerSample ?? 0);
  for (const t of ticks) {
    ctx.fillStyle = t.major ? THEME.gridMajor : THEME.grid;
    ctx.fillRect(Math.round(t.x), 0, 1, scene.height);
  }
}

function drawCursorBand(ctx: CanvasRenderingContext2D, scene: Scene): void {
  if (scene.cursorA === undefined || scene.cursorB === undefined) return;
  const xa = sampleToX(scene.viewport, scene.cursorA);
  const xb = sampleToX(scene.viewport, scene.cursorB);
  ctx.fillStyle = THEME.goldSoft;
  ctx.fillRect(Math.min(xa, xb), 0, Math.abs(xb - xa), scene.height);
}

function drawLogicColumns(ctx: CanvasRenderingContext2D, row: Extract<TraceRow, { kind: 'logic' }>, top: number, cols: Columns): void {
  const mask = (1 << row.channel) >>> 0;
  const hiY = top + 7.5;
  const loY = top + row.height - 7.5;
  const line = new Path2D();
  const fill = new Path2D();
  const busy = new Path2D();
  let prev = -1;
  let highStart = -1;
  for (let x = 0; x < cols.valid; x++) {
    const any = (cols.or[x] & mask) !== 0;
    const all = (cols.and[x] & mask) !== 0;
    const state = !any ? 0 : all ? 1 : 2;
    if (state === 2) {
      busy.rect(x, hiY, 1, loY - hiY);
      if (highStart >= 0) {
        fill.rect(highStart, hiY, x - highStart, loY - hiY);
        highStart = -1;
      }
      prev = 2;
      continue;
    }
    const y = state === 1 ? hiY : loY;
    if (prev === -1 || prev === 2) line.moveTo(x, y);
    else if (prev !== state) line.lineTo(x, y);
    line.lineTo(x + 1, y);
    if (state === 1 && highStart < 0) highStart = x;
    if (state === 0 && highStart >= 0) {
      fill.rect(highStart, hiY, x - highStart, loY - hiY);
      highStart = -1;
    }
    prev = state;
  }
  if (highStart >= 0) fill.rect(highStart, hiY, cols.valid - highStart, loY - hiY);
  strokeLogic(ctx, row.color, line, fill, busy);
}

function drawLogicSamples(ctx: CanvasRenderingContext2D, scene: Scene, row: Extract<TraceRow, { kind: 'logic' }>, top: number): void {
  const { viewport: v, pyramid, sampleCount, width } = scene;
  const hiY = top + 7.5;
  const loY = top + row.height - 7.5;
  const first = Math.max(0, Math.floor(v.start));
  const last = Math.min(sampleCount - 1, Math.ceil(v.start + width * v.spp));
  const line = new Path2D();
  const fill = new Path2D();
  let prevLevel = -1;
  for (let i = first; i <= last; i++) {
    const level = pyramid.bit(row.channel, i);
    const x0 = sampleToX(v, i);
    const x1 = sampleToX(v, i + 1);
    const y = level ? hiY : loY;
    if (prevLevel < 0) line.moveTo(x0, y);
    else line.lineTo(x0, y);
    line.lineTo(x1, y);
    if (level) fill.rect(x0, hiY, x1 - x0, loY - hiY);
    prevLevel = level;
  }
  strokeLogic(ctx, row.color, line, fill, undefined);
  // Sample dots once samples are far enough apart to tell apart.
  if (1 / v.spp >= 12) {
    ctx.fillStyle = row.color;
    for (let i = first; i <= last; i++) {
      const x = sampleToX(v, i + 0.5);
      const y = pyramid.bit(row.channel, i) ? hiY : loY;
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }
}

function strokeLogic(ctx: CanvasRenderingContext2D, color: string, line: Path2D, fill: Path2D, busy: Path2D | undefined): void {
  ctx.globalAlpha = 0.13;
  ctx.fillStyle = color;
  ctx.fill(fill);
  ctx.globalAlpha = 1;
  if (busy) {
    // Dense activity reads as texture, not as the brightest thing on screen.
    ctx.globalAlpha = 0.5;
    ctx.fill(busy);
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'miter';
  ctx.stroke(line);
}

const range = { min: 0, max: 0 };

function drawAnalog(ctx: CanvasRenderingContext2D, scene: Scene, row: Extract<TraceRow, { kind: 'analog' }>, top: number): void {
  const { viewport: v, width, sampleCount } = scene;
  const p = row.pyramid;
  const pad = 6;
  const lo = p.globalMin;
  const hi = p.globalMax === p.globalMin ? p.globalMin + 1 : p.globalMax;
  const yOf = (val: number): number => top + pad + (1 - (val - lo) / (hi - lo)) * (row.height - 2 * pad);
  // Zero/limit guides
  ctx.fillStyle = THEME.grid;
  ctx.fillRect(0, Math.round(yOf(lo)), width, 1);
  ctx.fillRect(0, Math.round(yOf(hi)), width, 1);
  const path = new Path2D();
  if (v.spp < 1) {
    const first = Math.max(0, Math.floor(v.start));
    const last = Math.min(sampleCount - 1, Math.ceil(v.start + width * v.spp));
    for (let i = first; i <= last; i++) {
      const x = sampleToX(v, i + 0.5);
      if (i === first) path.moveTo(x, yOf(p.data[i]));
      else path.lineTo(x, yOf(p.data[i]));
    }
  } else {
    let started = false;
    for (let x = 0; x < width; x++) {
      const s0 = Math.floor(v.start + x * v.spp);
      if (s0 >= sampleCount) break;
      const s1 = Math.min(sampleCount, Math.max(s0 + 1, Math.floor(v.start + (x + 1) * v.spp)));
      p.range(s0, s1, range);
      const yMax = yOf(range.max);
      const yMin = yOf(range.min);
      if (!started) {
        path.moveTo(x + 0.5, yMax);
        started = true;
      } else path.lineTo(x + 0.5, yMax);
      path.lineTo(x + 0.5, Math.max(yMin, yMax + 1));
    }
  }
  ctx.strokeStyle = row.color;
  ctx.lineWidth = 1.25;
  ctx.stroke(path);
  ctx.fillStyle = THEME.silkDim;
  ctx.font = `500 11px ${THEME.font}`;
  ctx.textBaseline = 'top';
  ctx.fillText(`${trim(hi)} ${row.unit}`, 4, top + 2);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${trim(lo)} ${row.unit}`, 4, top + row.height - 2);
}

function trim(n: number): string {
  return String(Number(n.toPrecision(3)));
}

/** Index of the first annotation whose end is after `sample` (annotations in a row do not overlap). */
function firstVisible(anns: readonly Annotation[], sample: number): number {
  let lo = 0;
  let hi = anns.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (anns[mid].end <= sample) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function drawAnnotations(ctx: CanvasRenderingContext2D, scene: Scene, row: Extract<TraceRow, { kind: 'decoder' }>, top: number): void {
  const { viewport: v, width } = scene;
  const anns = row.annotations;
  const viewEnd = v.start + width * v.spp;
  const y = top + 4;
  const h = row.height - 9;
  ctx.font = `500 12px ${THEME.font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  let busyStart = -1;
  let busyEnd = -1;
  const flushBusy = (): void => {
    if (busyStart < 0) return;
    ctx.fillStyle = row.color;
    ctx.globalAlpha = 0.45;
    ctx.fillRect(busyStart, y + h / 2 - 3, Math.max(1, busyEnd - busyStart), 6);
    ctx.globalAlpha = 1;
    busyStart = -1;
  };
  for (let i = firstVisible(anns, v.start); i < anns.length && anns[i].start < viewEnd; i++) {
    const a = anns[i];
    const x0 = sampleToX(v, a.start);
    const x1 = sampleToX(v, a.end);
    if (x1 - x0 < 3) {
      if (busyStart >= 0 && x0 <= busyEnd + 2) busyEnd = Math.max(busyEnd, x1);
      else {
        flushBusy();
        busyStart = x0;
        busyEnd = x1;
      }
      continue;
    }
    flushBusy();
    drawAnnotationBox(ctx, a, x0, x1, y, h, width, a === scene.selected);
  }
  flushBusy();
  ctx.textAlign = 'start';
}

function drawAnnotationBox(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  x0: number,
  x1: number,
  y: number,
  h: number,
  width: number,
  selected: boolean,
): void {
  const color = ANNOTATION_COLORS[a.kind];
  const left = Math.max(x0, -2);
  const right = Math.min(x1, width + 2);
  const notch = Math.min(5, (x1 - x0) / 3);
  ctx.beginPath();
  // Hexagonal "bus value" shape: the pointed ends mark the frame boundaries.
  ctx.moveTo(x0, y + h / 2);
  ctx.lineTo(x0 + notch, y);
  ctx.lineTo(x1 - notch, y);
  ctx.lineTo(x1, y + h / 2);
  ctx.lineTo(x1 - notch, y + h);
  ctx.lineTo(x0 + notch, y + h);
  ctx.closePath();
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = selected ? THEME.gold : color;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.stroke();
  const room = right - left - 2 * notch - 4;
  if (room < 6) return;
  const text = a.texts.find((t) => ctx.measureText(t).width <= room);
  if (!text) return;
  ctx.fillStyle = THEME.silk;
  ctx.fillText(text, (left + right) / 2, y + h / 2 + 0.5);
}

function drawMarkers(ctx: CanvasRenderingContext2D, scene: Scene, height: number): void {
  const v = scene.viewport;
  ctx.save();
  if (scene.burstStarts) {
    ctx.strokeStyle = THEME.burst;
    ctx.setLineDash([2, 4]);
    for (const s of scene.burstStarts) vline(ctx, sampleToX(v, s), height);
  }
  if (scene.triggerSample !== undefined) {
    ctx.strokeStyle = THEME.silkDim;
    ctx.setLineDash([4, 4]);
    vline(ctx, sampleToX(v, scene.triggerSample), height);
  }
  ctx.setLineDash([]);
  if (scene.probeSample !== undefined) {
    ctx.strokeStyle = 'rgba(230, 235, 227, 0.35)';
    vline(ctx, sampleToX(v, scene.probeSample), height);
  }
  ctx.strokeStyle = THEME.gold;
  ctx.lineWidth = 1.5;
  if (scene.cursorA !== undefined) vline(ctx, sampleToX(v, scene.cursorA), height);
  if (scene.cursorB !== undefined) vline(ctx, sampleToX(v, scene.cursorB), height);
  ctx.restore();
}

function vline(ctx: CanvasRenderingContext2D, x: number, height: number): void {
  if (x < -2 || x > ctx.canvas.width + 2) return;
  const px = Math.round(x) + 0.5;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, height);
  ctx.stroke();
}

export interface RulerScene {
  readonly width: number;
  readonly height: number;
  readonly viewport: Viewport;
  readonly sampleRate: number;
  readonly originSample: number;
  readonly cursorA?: number;
  readonly cursorB?: number;
  readonly triggerSample?: number;
}

export function drawRuler(ctx: CanvasRenderingContext2D, r: RulerScene): void {
  ctx.fillStyle = THEME.board;
  ctx.fillRect(0, 0, r.width, r.height);
  ctx.fillStyle = THEME.trace;
  ctx.fillRect(0, r.height - 1, r.width, 1);
  const ticks = timeTicks(r.viewport, r.width, r.sampleRate, r.originSample);
  ctx.font = `500 12px ${THEME.font}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  for (const t of ticks) {
    const x = Math.round(t.x);
    ctx.fillStyle = t.major ? THEME.silkDim : THEME.silkFaint;
    ctx.fillRect(x, r.height - (t.major ? 10 : 5), 1, t.major ? 10 : 5);
    if (t.major && t.label) {
      ctx.fillStyle = THEME.silkDim;
      ctx.fillText(t.label, x + 4, 5);
    }
  }
  if (r.triggerSample !== undefined) {
    const x = sampleToX(r.viewport, r.triggerSample);
    ctx.fillStyle = THEME.gold;
    ctx.beginPath();
    ctx.moveTo(x - 5, r.height - 9);
    ctx.lineTo(x + 5, r.height - 9);
    ctx.lineTo(x, r.height - 1);
    ctx.closePath();
    ctx.fill();
  }
  cursorFlag(ctx, r, r.cursorA, 'A');
  cursorFlag(ctx, r, r.cursorB, 'B');
}

function cursorFlag(ctx: CanvasRenderingContext2D, r: RulerScene, sample: number | undefined, label: string): void {
  if (sample === undefined) return;
  const x = Math.round(sampleToX(r.viewport, sample));
  if (x < -20 || x > r.width + 20) return;
  ctx.fillStyle = THEME.gold;
  ctx.fillRect(x, 0, 1.5, r.height);
  ctx.beginPath();
  ctx.roundRect(x - 9, r.height - 20, 18, 16, 3);
  ctx.fill();
  ctx.fillStyle = THEME.mask;
  ctx.font = `700 12px ${THEME.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, r.height - 11.5);
  ctx.textAlign = 'left';
}
