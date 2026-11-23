import {describe, expect, test} from 'vitest';
import {appendPenSamples, PEN_SAMPLE_STEP} from '../editor-drawing.ts';
import type {Point} from '../geometry.ts';

/** 同一屏幕轨迹在不同 zoom 下对应的世界坐标；采样阈值必须与 zoom 解耦。 */
function sampleAtZoom(zoom: number, screenStep = 20, count = 30): Point[] {
  const points: Point[] = [[0, 0]];
  for (let index = 1; index <= count; index++) {
    appendPenSamples(points, [[index * screenStep / zoom, 0]]);
  }
  return points;
}

describe('pen sampling is independent of temporary viewport', () => {
  test('10%, 100% and 800% keep the same sample count and world spacing', () => {
    const runs = [0.1, 1, 8].map(zoom => ({zoom, points: sampleAtZoom(zoom)}));
    const counts = runs.map(run => run.points.length);
    expect(new Set(counts).size).toBe(1);
    for (const {zoom, points} of runs) {
      for (let index = 1; index < points.length; index++) {
        const spacing = Math.hypot(points[index][0] - points[index - 1][0],
          points[index][1] - points[index - 1][1]);
        expect(spacing).toBeGreaterThanOrEqual(PEN_SAMPLE_STEP);
        expect(spacing).toBeCloseTo(20 / zoom, 9);
      }
    }
  });

  test('a 10 CSS px pen movement survives at 10% and 800%', () => {
    for (const zoom of [0.1, 8]) {
      expect(sampleAtZoom(zoom, 10, 20)).toHaveLength(21);
    }
  });

  test('samples closer than the fixed world step are ignored', () => {
    const points: Point[] = [[0, 0]];
    appendPenSamples(points, [[0.1, 0], [0.2, 0], [0.6, 0]]);
    expect(points).toEqual([[0, 0], [0.6, 0]]);
  });
});
