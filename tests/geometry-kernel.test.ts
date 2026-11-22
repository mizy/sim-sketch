import {readFileSync} from 'node:fs';
import {beforeAll, describe, expect, test} from 'vitest';
import {arcPoints, circlePoints} from '../geometry.ts';
import type {CircleShape, Point, Polygon} from '../geometry.ts';
import {
  extendPolyline,
  filletPolyline,
  flattenArc,
  flattenCircle,
  flattenCubicBezier,
  initGeometryKernel,
  offsetPolyline,
  polylineIntersections,
  tessellatePolygons,
  trimPolyline
} from '../kernel.ts';

beforeAll(async () => {
  await initGeometryKernel(readFileSync(new URL('../wasm/pkg/sim_sketch_geometry.wasm', import.meta.url)));
});

const square = (size = 10): Point[] => [[0, 0], [size, 0], [size, size], [0, size]];

function ringArea(ring: readonly Point[]): number {
  let total = 0;
  for (let index = 0; index < ring.length; index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    total += x1 * y2 - x2 * y1;
  }
  return Math.abs(total) / 2;
}

function triangleArea(positions: Float32Array, indices: Uint32Array): number {
  let total = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const [ax, ay] = [positions[indices[index] * 2], positions[indices[index] * 2 + 1]];
    const [bx, by] = [positions[indices[index + 1] * 2], positions[indices[index + 1] * 2 + 1]];
    const [cx, cy] = [positions[indices[index + 2] * 2], positions[indices[index + 2] * 2 + 1]];
    total += ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  return Math.abs(total);
}

function expectClose(actual: readonly number[], expected: readonly number[], tolerance = 1e-9): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(tolerance));
}

describe('curve flattening', () => {
  test('circle flattening matches the legacy sampler exactly', () => {
    const shape: CircleShape = {
      id: 'circle', type: 'circle', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4, center: [10, -4], radius: 7
    };
    const legacy = circlePoints(shape);
    const flattened = flattenCircle(shape.center, shape.radius);
    expect(flattened).toHaveLength(legacy.length);
    flattened.forEach((point, index) => expectClose(point, legacy[index], 1e-9));
    expect(ringArea(flattened)).toBeCloseTo(0.5 * 32 * 49 * Math.sin(2 * Math.PI / 32), 9);
  });

  test('arc flattening matches the legacy sampler and keeps both endpoints', () => {
    const points: Point[] = [[0, 10], [10, 0], [20, 10]];
    const legacy = arcPoints({
      id: 'arc', type: 'arc', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4, points
    });
    const flattened = flattenArc(points);
    expect(flattened).toHaveLength(legacy.length);
    flattened.forEach((point, index) => expectClose(point, legacy[index], 1e-9));
    expectClose(flattened[0], [0, 10]);
    expectClose(flattened[flattened.length - 1], [20, 10]);
    for (const [x, y] of flattened) expect(Math.hypot(x - 10, y - 10)).toBeCloseTo(10, 9);
  });

  test('degenerate and tiny inputs stay finite', () => {
    expect(flattenCircle([3, 4], 0)).toEqual([]);
    expect(flattenCircle([3, 4], Number.NaN)).toEqual([]);
    expect(flattenArc([[0, 0], [1, 0], [2, 0]])).toEqual([[0, 0], [2, 0]]);
    expect(flattenArc([[5, 5]])).toEqual([[5, 5]]);
    const tiny = flattenCircle([1e6, -1e6], 1e-6);
    expect(tiny).toHaveLength(32);
    expect(tiny.every(point => point.every(Number.isFinite))).toBe(true);
  });

  test('cubic Bézier flattening is adaptive and bounded', () => {
    const flat = flattenCubicBezier([0, 0], [3, 0], [6, 0], [9, 0], 0.1);
    expect(flat).toHaveLength(2);
    expectClose(flat[0], [0, 0]);
    expectClose(flat[1], [9, 0]);

    const curved = flattenCubicBezier([0, 0], [0, 30], [30, 30], [30, 0], 0.5);
    expect(curved.length).toBeGreaterThan(4);
    expect(curved.length).toBeLessThan(200);
    expectClose(curved[0], [0, 0]);
    expectClose(curved[curved.length - 1], [30, 0]);
    for (const [x, y] of curved) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(22.5 + 1e-9);
    }
    expect(flattenCubicBezier([2, 3], [2, 3], [2, 3], [2, 3], 0.1)).toEqual([[2, 3]]);
  });
});

describe('polygon triangulation', () => {
  test('rectangle produces two CCW triangles with the exact area', () => {
    const {positions, indices} = tessellatePolygons([[square()]]);
    expect(positions).toHaveLength(8);
    expect(indices).toHaveLength(6);
    expect(triangleArea(positions, indices)).toBeCloseTo(100, 9);
    for (let index = 0; index < indices.length; index += 3) {
      const [ax, ay] = [positions[indices[index] * 2], positions[indices[index] * 2 + 1]];
      const [bx, by] = [positions[indices[index + 1] * 2], positions[indices[index + 1] * 2 + 1]];
      const [cx, cy] = [positions[indices[index + 2] * 2], positions[indices[index + 2] * 2 + 1]];
      expect((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)).toBeGreaterThan(0);
    }
  });

  test('holes are subtracted during triangulation', () => {
    const polygon: Polygon = [square(10), [[3, 3], [3, 7], [7, 7], [7, 3]]];
    const {positions, indices} = tessellatePolygons([polygon]);
    expect(indices.length % 3).toBe(0);
    expect(triangleArea(positions, indices)).toBeCloseTo(84, 9);
  });

  test('multiple components accumulate into one buffer', () => {
    const moved: Polygon = [square(4).map(([x, y]) => [x + 20, y] as Point)];
    const {positions, indices} = tessellatePolygons([[square(4)], moved]);
    expect(indices).toHaveLength(12);
    expect(triangleArea(positions, indices)).toBeCloseTo(32, 9);
  });

  test('degenerate rings emit nothing instead of NaNs', () => {
    expect(tessellatePolygons([])).toEqual({positions: new Float32Array(), indices: new Uint32Array()});
    expect(tessellatePolygons([[ [[0, 0], [1, 1], [2, 2]] ]]).indices).toHaveLength(0);
    expect(tessellatePolygons([[ [[0, 0], [0, 0], [0, 0]] ]]).indices).toHaveLength(0);
    expect(tessellatePolygons([[ [[0, 0], [1, 0], [1, 0], [0, 1]] ]]).indices.length % 3).toBe(0);
  });

  test('large coordinates keep area accuracy', () => {
    const offset = 1_000_000;
    const ring: Point[] = square(10).map(([x, y]) => [x + offset, y - offset] as Point);
    const {positions, indices} = tessellatePolygons([[ring]]);
    expect(triangleArea(positions, indices)).toBeCloseTo(100, 6);
  });
});

describe('intersections', () => {
  test('crossing segments report point and parameters', () => {
    const hits = polylineIntersections([[0, 0], [10, 0]], [[5, -5], [5, 5]]);
    expect(hits).toHaveLength(1);
    expectClose(hits[0].point, [5, 0]);
    expect(hits[0]).toMatchObject({aSegment: 0, bSegment: 0});
    expect(hits[0].t).toBeCloseTo(0.5, 12);
    expect(hits[0].u).toBeCloseTo(0.5, 12);
  });

  test('parallel, disjoint and zero-length inputs report nothing', () => {
    expect(polylineIntersections([[0, 0], [10, 0]], [[0, 1], [10, 1]])).toEqual([]);
    expect(polylineIntersections([[0, 0], [2, 0]], [[5, -1], [5, 1]])).toEqual([]);
    expect(polylineIntersections([[0, 0], [0, 0]], [[0, 0], [1, 1]])).toEqual([]);
  });

  test('collinear overlap reports both overlap endpoints', () => {
    const hits = polylineIntersections([[0, 0], [10, 0]], [[3, 0], [7, 0]]);
    expect(hits.map(hit => hit.point)).toEqual([[3, 0], [7, 0]]);
    expect(hits[0].t).toBeCloseTo(0.3, 12);
    expect(hits[1].t).toBeCloseTo(0.7, 12);
  });

  test('endpoint touches count and multi-segment ordering is stable', () => {
    const hits = polylineIntersections([[0, 0], [10, 0], [10, 10]], [[5, -1], [5, 1], [1, 10], [20, 10]]);
    expect(hits).toHaveLength(2);
    expectClose(hits[0].point, [5, 0]);
    expectClose(hits[1].point, [10, 10]);
    expect(hits.map(hit => hit.aSegment)).toEqual([0, 1]);
  });
});

describe('trim and extend', () => {
  const boundary: Point[] = [[5, -10], [5, 10]];

  test('trim keeps the requested side and reports no-op', () => {
    const start = trimPolyline([[0, 0], [10, 0]], boundary, 'start');
    expect(start.changed).toBe(true);
    expect(start.points).toEqual([[0, 0], [5, 0]]);

    const end = trimPolyline([[0, 0], [10, 0]], boundary, 'end');
    expect(end.changed).toBe(true);
    expect(end.points).toEqual([[5, 0], [10, 0]]);

    const missed = trimPolyline([[0, 5], [10, 5]], [[5, 0], [5, 4]], 'start');
    expect(missed.changed).toBe(false);
    expect(missed.points).toEqual([[0, 5], [10, 5]]);
  });

  test('trim chooses the first or last crossing deterministically', () => {
    const crossings: Point[] = [[0, 0], [10, 0]];
    const first = trimPolyline(crossings, [[3, -5], [3, 5], [7, -5], [7, 5]], 'start');
    expect(first.points).toEqual([[0, 0], [3, 0]]);
    const last = trimPolyline(crossings, [[3, -5], [3, 5], [7, -5], [7, 5]], 'end');
    expect(last.points).toEqual([[7, 0], [10, 0]]);
  });

  test('extend reaches the boundary on either side', () => {
    const end = extendPolyline([[0, 0], [4, 0]], boundary, 'end');
    expect(end.changed).toBe(true);
    expect(end.points).toEqual([[0, 0], [4, 0], [5, 0]]);

    const start = extendPolyline([[6, 0], [10, 0]], boundary, 'start');
    expect(start.changed).toBe(true);
    expect(start.points).toEqual([[5, 0], [6, 0], [10, 0]]);
  });

  test('extend falls back to distance and stays untouched without a target', () => {
    const byDistance = extendPolyline([[0, 0], [4, 0]], [], 'end', 3);
    expect(byDistance.changed).toBe(true);
    expectClose(byDistance.points[byDistance.points.length - 1], [7, 0]);

    const untouched = extendPolyline([[0, 0], [4, 0]], [], 'end', 0);
    expect(untouched).toEqual({changed: false, points: [[0, 0], [4, 0]]});
    expect(extendPolyline([[0, 0]], boundary, 'end')).toEqual({changed: false, points: [[0, 0]]});
  });

  test('nearly parallel extension does not invent a distant hit', () => {
    const result = extendPolyline([[0, 0], [4, 0]], [[100, 1], [200, 2]], 'end');
    expect(result.points).toHaveLength(2);
  });
});

describe('offset', () => {
  test('closed square grows and shrinks by the exact miter area', () => {
    const grown = offsetPolyline(square(), 2, {closed: true});
    expect(grown).toHaveLength(4);
    expect(ringArea(grown)).toBeCloseTo(196, 9);
    expect(grown.map(point => point.map(value => Math.round(value * 1e9) / 1e9)).sort())
      .toEqual([[-2, -2], [-2, 12], [12, -2], [12, 12]].sort());

    const shrunk = offsetPolyline(square(), -2, {closed: true});
    expect(ringArea(shrunk)).toBeCloseTo(36, 9);
  });

  test('clockwise input still grows outward and open lines offset to the left', () => {
    const clockwise = offsetPolyline(square().reverse(), 2, {closed: true});
    expect(ringArea(clockwise)).toBeCloseTo(196, 9);
    const clockwiseShrunk = offsetPolyline(square().reverse(), -2, {closed: true});
    expect(ringArea(clockwiseShrunk)).toBeCloseTo(36, 9);
    expect(offsetPolyline([[0, 0], [10, 0]], 2)).toEqual([[0, 2], [10, 2]]);
    expect(offsetPolyline([[0, 0], [10, 0]], -2)).toEqual([[0, -2], [10, -2]]);
  });

  test('round joins emit arcs and miter limits fall back to bevels', () => {
    const round = offsetPolyline(square(), 2, {closed: true, join: 'round'});
    expect(round.length).toBeGreaterThan(8);
    expect(ringArea(round)).toBeGreaterThan(190);
    const bevel = offsetPolyline([[0, 0], [10, 0], [10, 0.2]], 5, {miterLimit: 1.2});
    expect(bevel.length).toBeGreaterThan(3);
  });

  test('degenerate offsets are finite no-ops', () => {
    expect(offsetPolyline(square(), 0, {closed: true})).toEqual(square());
    expect(offsetPolyline([[2, 3]], 4)).toEqual([[2, 3]]);
    expect(offsetPolyline(square(), Number.NaN)).toEqual(square());
  });
});

describe('fillet', () => {
  test('one corner becomes a tangent arc with the requested radius', () => {
    const rounded = filletPolyline([[0, 0], [10, 0], [10, 10]], 2, {segments: 8});
    expect(rounded).toHaveLength(11);
    expectClose(rounded[0], [0, 0]);
    expectClose(rounded[1], [8, 0]);
    expectClose(rounded[rounded.length - 2], [10, 2]);
    expectClose(rounded[rounded.length - 1], [10, 10]);
    for (const point of rounded.slice(1, -1)) {
      expect(Math.hypot(point[0] - 8, point[1] - 2)).toBeCloseTo(2, 9);
    }
  });

  test('all corners round a square and keep it bounded', () => {
    const rounded = filletPolyline(square(), 2, {segments: 6, closed: true});
    expect(rounded).toHaveLength(28);
    expect(ringArea(rounded)).toBeLessThan(100);
    expect(ringArea(rounded)).toBeGreaterThan(96);
    for (const [x, y] of rounded) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(10 + 1e-9);
      expect(y).toBeLessThanOrEqual(10 + 1e-9);
    }
  });

  test('single-corner selection and oversized radii clamp instead of flipping', () => {
    const selected = filletPolyline(square(10), 2, {corner: 1, segments: 4, closed: true});
    expect(selected).toHaveLength(8);
    expectClose(selected[1], [8, 0]);
    expectClose(selected[5], [10, 2]);
    const clamped = filletPolyline([[0, 0], [10, 0], [10, 10]], 50, {segments: 4});
    expect(clamped.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    expect(Math.max(...clamped.map(([x]) => x))).toBeLessThanOrEqual(10 + 1e-9);
  });

  test('collinear and degenerate inputs stay untouched', () => {
    expect(filletPolyline([[0, 0], [5, 0], [10, 0]], 1)).toEqual([[0, 0], [5, 0], [10, 0]]);
    expect(filletPolyline([[0, 0], [10, 0]], 1)).toEqual([[0, 0], [10, 0]]);
    expect(filletPolyline([[0, 0], [10, 0], [10, 10]], 0)).toEqual([[0, 0], [10, 0], [10, 10]]);
  });
});
