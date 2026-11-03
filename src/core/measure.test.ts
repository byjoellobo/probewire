import { describe, expect, it } from 'vitest';
import { countEdges, measurePulse } from './measure';
import { LogicPyramid } from './pyramid';

// Channel 0: 25% duty square wave with a 100-sample period, starting low.
const words = new Uint8Array(1000);
for (let i = 0; i < 1000; i++) words[i] = i % 100 >= 75 ? 1 : 0;
const pyr = new LogicPyramid(words);

describe('measurePulse', () => {
  it('measures a high pulse with period and duty cycle', () => {
    const m = measurePulse(pyr, 0, 180, 1_000_000);
    expect(m).toMatchObject({ level: 1, start: 175, end: 200, truncated: false });
    expect(m?.widthSeconds).toBeCloseTo(25e-6);
    expect(m?.periodSeconds).toBeCloseTo(100e-6);
    expect(m?.frequency).toBeCloseTo(10_000);
    expect(m?.dutyCycle).toBeCloseTo(0.25);
  });

  it('measures a low pulse', () => {
    const m = measurePulse(pyr, 0, 230, 1_000_000);
    expect(m).toMatchObject({ level: 0, start: 200, end: 275 });
    expect(m?.dutyCycle).toBeCloseTo(0.25);
  });

  it('flags pulses cut off by the capture edges', () => {
    expect(measurePulse(pyr, 0, 10, 1e6)?.truncated).toBe(true);
    expect(measurePulse(pyr, 0, 990, 1e6)?.truncated).toBe(true);
    expect(measurePulse(pyr, 0, 5000, 1e6)).toBeUndefined();
  });
});

describe('countEdges', () => {
  it('counts both edge directions', () => {
    expect(countEdges(pyr, 0, 0, 1000)).toBe(19);
    expect(countEdges(pyr, 0, 0, 100)).toBe(1);
    expect(countEdges(pyr, 1, 0, 1000)).toBe(0);
  });
});
