/** Builds the trace rows shown in the waveform view, and the probe readout. */
import { measurePulse } from '../core/measure';
import { formatDuration, formatFrequency } from '../core/units';
import { getDecoder } from '../decoders/registry';
import type { Annotation, DecodeOutput } from '../decoders/types';
import { ANALOG_COLORS, DECODER_ACCENTS, channelColor, channelSwatch } from '../render/theme';
import type { Probe, RowSpec } from './components/TraceView';
import type { DecoderInstance, DecoderResult, Workspace } from './workspace';

export interface RowHeights {
  readonly logic: number;
  readonly analog: number;
  readonly decoder: number;
}

export const ROW_HEIGHTS: RowHeights = { logic: 34, analog: 76, decoder: 30 };
export const COMPACT_ROW_HEIGHTS: RowHeights = { logic: 30, analog: 64, decoder: 28 };

const byRowCache = new WeakMap<DecodeOutput, Annotation[][]>();

/** Annotations split by decoder row, each list sorted by start. */
export function annotationsByRow(output: DecodeOutput, rowCount: number): Annotation[][] {
  const cached = byRowCache.get(output);
  if (cached) return cached;
  const rows: Annotation[][] = Array.from({ length: rowCount }, () => []);
  for (const a of output.annotations) rows[a.row]?.push(a);
  byRowCache.set(output, rows);
  return rows;
}

export function decoderAccent(instances: readonly DecoderInstance[], uid: string): string {
  const i = Math.max(
    0,
    instances.findIndex((d) => d.uid === uid),
  );
  return DECODER_ACCENTS[i % DECODER_ACCENTS.length];
}

export function buildRows(
  ws: Workspace,
  decoders: readonly DecoderInstance[],
  results: Readonly<Record<string, DecoderResult>>,
  heights: RowHeights,
): RowSpec[] {
  const rows: RowSpec[] = ws.capture.channels.map((ch) => ({
    key: `L${ch.index}`,
    label: ch.name,
    swatch: channelSwatch(ch.index),
    height: heights.logic,
    channel: ch.index,
    trace: { kind: 'logic', key: `L${ch.index}`, channel: ch.index, color: channelColor(ch.index), height: heights.logic },
  }));
  ws.capture.analog.forEach((a, k) => {
    const color = ANALOG_COLORS[k % ANALOG_COLORS.length];
    rows.push({
      key: `A${k}`,
      label: a.name,
      swatch: color,
      height: heights.analog,
      trace: { kind: 'analog', key: `A${k}`, pyramid: ws.analog[k], color, height: heights.analog, unit: a.unit },
    });
  });
  let firstDecoderRow = true;
  decoders.forEach((inst) => {
    const def = getDecoder(inst.decoderId);
    const res = results[inst.uid];
    if (!def || !res?.ok) return;
    const accent = decoderAccent(decoders, inst.uid);
    const perRow = annotationsByRow(res.output, def.rows.length);
    def.rows.forEach((r, ri) => {
      if (inst.hiddenRows.includes(r.id)) return;
      const key = `D${inst.uid}:${ri}`;
      // Decoder rows carry a decoder tag ("UART" + "TX") so they never read as a channel name.
      rows.push({
        key,
        label: r.label,
        tag: def.name,
        title: `${def.longName}: ${r.label}`,
        swatch: accent,
        height: heights.decoder,
        groupStart: firstDecoderRow,
        trace: { kind: 'decoder', key, annotations: perRow[ri], color: accent, height: heights.decoder, groupStart: firstDecoderRow },
      });
      firstDecoderRow = false;
    });
  });
  return rows;
}

/** Duty cycle as a percentage; bursty signals read "under 1%" rather than a misleading "0.0%". */
export function formatDuty(duty: number): string {
  if (duty > 0 && duty < 0.01) return 'under 1%';
  if (duty < 1 && duty > 0.99) return 'over 99%';
  return `${(duty * 100).toFixed(1)}%`;
}

/** Annotation in `anns` covering `sample`, if any (anns sorted, non-overlapping). */
export function annotationAt(anns: readonly Annotation[], sample: number): Annotation | undefined {
  let lo = 0;
  let hi = anns.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (anns[mid].end <= sample) lo = mid + 1;
    else hi = mid;
  }
  const a = anns[lo];
  return a && a.start <= sample ? a : undefined;
}

/** One line describing what is under the probe. */
export function probeReadout(ws: Workspace, rows: readonly RowSpec[], probe: Probe | undefined): string | undefined {
  if (!probe) return undefined;
  const { capture } = ws;
  const s = Math.floor(probe.sample);
  if (s < 0 || s >= capture.sampleCount) return undefined;
  const time = formatDuration((s - (capture.triggerSample ?? 0)) / capture.sampleRate, 6);
  const row = rows.find((r) => r.key === probe.rowKey);
  if (!row) return `t = ${time}`;
  const t = row.trace;
  if (t.kind === 'logic') {
    const m = measurePulse(ws.pyramid, t.channel, s, capture.sampleRate);
    if (!m) return `t = ${time}`;
    const parts = [`${row.label} ${m.level ? 'high' : 'low'} for ${m.truncated ? 'at least ' : ''}${formatDuration(m.widthSeconds, 4)}`];
    if (m.periodSeconds !== undefined && m.frequency !== undefined && m.dutyCycle !== undefined) {
      parts.push(`period ${formatDuration(m.periodSeconds, 4)} (${formatFrequency(m.frequency)})`, `duty ${formatDuty(m.dutyCycle)}`);
    }
    return `${parts.join(', ')}  at ${time}`;
  }
  if (t.kind === 'analog') {
    return `${row.label} ${t.pyramid.data[s].toFixed(3)} ${t.unit}  at ${time}`;
  }
  const a = annotationAt(t.annotations, s);
  return a ? `${row.label}: ${a.texts[0]}  at ${time}` : `${row.label}  at ${time}`;
}
