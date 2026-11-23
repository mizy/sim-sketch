import {describe, expect, test} from 'vitest';
import {sampleBezierPath} from '../bezier.ts';
import type {Point} from '../geometry.ts';
import {fitErrorThreshold, fitPenMark, fitPenStroke, simplifyRdp} from '../pen-fit.ts';
import type {PenFitOptions} from '../pen-fit.ts';
import type {PenMark} from '../project.ts';

const options: PenFitOptions = {mode: 'line', curve: 'cubic', width: 4};

/** 固定种子的抖动，保证噪声用例可复现。 */
function noise(index: number): number {
  const value = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

describe('pen fitting', () => {
  test('straight point set becomes a line with fixed endpoints', () => {
    const points: Point[] = Array.from({length: 31}, (_, index) => [index * 4, 120 + Math.sin(index) * .15]);
    const result = fitPenStroke(points, {...options, mode: 'line'});
    expect(result).not.toBeNull();
    expect(result!.path.start).toEqual(points[0]);
    expect(result!.path.segments).toHaveLength(1);
    const segment = result!.path.segments[0];
    expect(segment.type).toBe('line');
    expect(segment.end).toEqual(points.at(-1));
    expect(result!.maxError).toBeLessThanOrEqual(result!.threshold);
  });

  test('smooth curve point set becomes a quadratic or cubic bezier path', () => {
    const quadraticSource = sampleBezierPath({start: [0, 80], segments: [
      {type: 'quadratic', control: [60, -40], end: [120, 80]}
    ]});
    const quadratic = fitPenStroke(quadraticSource, {...options, mode: 'curve', curve: 'quadratic'});
    expect(quadratic).not.toBeNull();
    expect(quadratic!.path.start).toEqual(quadraticSource[0]);
    expect(quadratic!.path.segments[0].type).toBe('quadratic');
    expect(quadratic!.path.segments[0].end).toEqual(quadraticSource.at(-1));
    expect(quadratic!.maxError).toBeLessThanOrEqual(quadratic!.threshold);

    const cubicSource = sampleBezierPath({start: [0, 100], segments: [
      {type: 'cubic', control1: [30, -20], control2: [90, 220], end: [140, 100]}
    ]});
    const cubic = fitPenStroke(cubicSource, {...options, mode: 'curve', curve: 'cubic'});
    expect(cubic).not.toBeNull();
    expect(cubic!.path.segments[0].type).toBe('cubic');
    expect(cubic!.maxError).toBeLessThanOrEqual(cubic!.threshold);
    const sampled = sampleBezierPath(cubic!.path);
    expect(sampled[0]).toEqual(cubicSource[0]);
    expect(sampled.at(-1)).toEqual(cubicSource.at(-1));
  });

  test('noisy point set above the adaptive threshold keeps the raw hand drawing', () => {
    const points: Point[] = Array.from({length: 61}, (_, index) =>
      [index * 3, 100 + noise(index) * 22]);
    const mark: PenMark = {
      id: 'pen', shape: 'pen', kind: 'note', label: '', value: null, unit: '',
      direction: '', question: '', confirmed: false, source: 'manual', layerId: 'layer',
      points, width: 4
    };
    for (const mode of ['line', 'curve'] as const) {
      const result = fitPenStroke(points, {...options, mode});
      expect(result).toBeNull();
      expect(fitPenMark(mark, {...options, mode})).toBe(mark);
    }
    // 阈值确实按笔宽/总长自适应，而不是固定值。
    expect(fitErrorThreshold(1, 50)).toBe(1.5);
    expect(fitErrorThreshold(24, 100)).toBeCloseTo(21.6, 9);
    expect(fitErrorThreshold(4, 10_000)).toBeCloseTo(200, 9);
  });

  test('RDP keeps endpoints and drops points within tolerance', () => {
    const points: Point[] = [[0, 0], [1, .05], [2, 0], [3, .05], [4, 0]];
    const simplified = simplifyRdp(points, 1);
    expect(simplified[0]).toEqual([0, 0]);
    expect(simplified.at(-1)).toEqual([4, 0]);
    expect(simplified.length).toBeLessThan(points.length);
  });
});
