import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatFrequency, formatTickTime } from '../core/units';
import { MIN_SPP, centerOn, clampViewport, fitViewport, niceStep, panBy, sampleToX, timeTicks, xToSample, zoomAt, zoomToRange } from './viewport';

const N = 1_000_000;
const W = 1000;

describe('viewport', () => {
  it('fits the whole capture', () => {
    const v = fitViewport(N, W);
    expect(v).toEqual({ start: 0, spp: 1000 });
    expect(xToSample(v, W)).toBe(N);
  });

  it('converts between samples and pixels', () => {
    const v = { start: 500, spp: 2 };
    expect(sampleToX(v, 700)).toBe(100);
    expect(xToSample(v, 100)).toBe(700);
  });

  it('zooms around the anchor', () => {
    const v = fitViewport(N, W);
    const z = zoomAt(v, 0.5, 250, N, W);
    expect(z.spp).toBe(500);
    expect(xToSample(z, 250)).toBeCloseTo(xToSample(v, 250));
  });

  it('clamps zoom and position to the capture', () => {
    expect(zoomAt(fitViewport(N, W), 10, 0, N, W)).toEqual(fitViewport(N, W));
    expect(zoomAt({ start: 0, spp: MIN_SPP }, 0.1, 0, N, W).spp).toBe(MIN_SPP);
    expect(panBy({ start: 10, spp: 1 }, 100, N, W).start).toBe(0);
    expect(panBy({ start: N - 2000, spp: 1 }, -5000, N, W).start).toBe(N - W);
    expect(clampViewport({ start: -5, spp: 1 }, 100, W)).toEqual({ start: 0, spp: 0.1 });
  });

  it('centres on a sample and zooms to a range', () => {
    expect(centerOn({ start: 0, spp: 1 }, 5000, N, W).start).toBe(4500);
    const r = zoomToRange(1000, 2000, N, W);
    expect(xToSample(r, 0)).toBeCloseTo(900);
    expect(xToSample(r, W)).toBeCloseTo(2100);
  });
});

describe('ruler ticks', () => {
  it('uses a 1-2-5 grid', () => {
    expect(niceStep(0.0003)).toBeCloseTo(0.0005);
    expect(niceStep(1.2)).toBe(2);
    expect(niceStep(7)).toBe(10);
  });

  it('labels major ticks relative to the trigger', () => {
    const ticks = timeTicks({ start: 0, spp: 10 }, 1000, 1_000_000, 5000);
    const majors = ticks.filter((t) => t.major);
    expect(majors.length).toBeGreaterThan(3);
    expect(majors.some((t) => t.label === '0')).toBe(true);
    expect(majors.some((t) => t.label.startsWith('-'))).toBe(true);
  });
});

describe('units', () => {
  it('formats durations', () => {
    expect(formatDuration(0.00125)).toBe('1.25 ms');
    expect(formatDuration(-80e-6)).toBe('-80 µs');
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(1 / 3, 3)).toBe('333 ms');
    expect(formatDuration(5e-10)).toBe('500 ps');
  });

  it('formats tick labels to the step precision', () => {
    expect(formatTickTime(0.0015, 0.0005)).toBe('1.5 ms');
    expect(formatTickTime(0.002, 0.001)).toBe('2 ms');
    expect(formatTickTime(2e-7, 1e-7)).toBe('200 ns');
  });

  it('uses the unit of the largest visible time deep into a capture', () => {
    expect(formatTickTime(0.2499, 0.0001, 0.2501)).toBe('249.9 ms');
    expect(formatTickTime(0.25, 0.0001, 0.2501)).toBe('250.0 ms');
  });

  it('formats frequencies and sizes', () => {
    expect(formatFrequency(12_500_000)).toBe('12.5 MHz');
    expect(formatFrequency(999)).toBe('999 Hz');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3 MB');
  });
});
