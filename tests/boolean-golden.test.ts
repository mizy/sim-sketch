import {readFileSync} from 'node:fs';
import {beforeAll, describe, expect, test} from 'vitest';
import {booleanShapes} from '../geometry.ts';
import type {CircleShape, PathShape, Point, Polygon, RectShape, Shape} from '../geometry.ts';
import {initGeometryKernel} from '../kernel.ts';

const TOLERANCE = 1e-6;

const rect = (x1: number, y1: number, x2: number, y2: number): RectShape => ({
  id: 'rect', type: 'rect', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4, a: [x1, y1], b: [x2, y2]
});
const circle = (x: number, y: number, radius: number): CircleShape => ({
  id: 'circle', type: 'circle', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4, center: [x, y], radius
});
const path = (polygons: Polygon[]): PathShape => ({
  id: 'path', type: 'path', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4, polygons
});

beforeAll(async () => {
  const bytes = readFileSync(new URL('../wasm/pkg/sim_sketch_geometry.wasm', import.meta.url));
  await initGeometryKernel(bytes);
});

interface Metrics {
  components: number;
  rings: number;
  area: number;
  bbox: [number, number, number, number] | null;
}

function ringArea(ring: Point[]): number {
  let total = 0;
  for (let index = 0; index < ring.length; index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    total += x1 * y2 - x2 * y1;
  }
  return Math.abs(total) / 2;
}

function signedArea(ring: Point[]): number {
  let total = 0;
  for (let index = 0; index < ring.length; index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    total += x1 * y2 - x2 * y1;
  }
  return total / 2;
}

function dropCollinear(ring: Point[]): Point[] {
  const points = ring.map(([x, y]) => [x, y] as Point);
  if (points.length > 1 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1]) points.pop();
  let index = 0;
  while (points.length > 3 && index < points.length) {
    const previous = points[(index + points.length - 1) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = (current[0] - previous[0]) * (next[1] - current[1]) -
      (current[1] - previous[1]) * (next[0] - current[0]);
    if (Math.abs(cross) <= 1e-9) {
      points.splice(index, 1);
      index = 0;
    } else index++;
  }
  return points;
}

function compareRings(left: Point[], right: Point[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index][0] !== right[index][0]) return left[index][0] - right[index][0];
    if (left[index][1] !== right[index][1]) return left[index][1] - right[index][1];
  }
  return left.length - right.length;
}

/** 归一化到 CCW + 最小顶点起点，比较真实 ring 形状而不是只看面积。 */
function canonicalRing(ring: Point[]): Point[] {
  const points = dropCollinear(ring);
  if (!points.length) return points;
  if (signedArea(points) < 0) points.reverse();
  let start = 0;
  for (let index = 1; index < points.length; index++) {
    if (points[index][0] < points[start][0] ||
      (points[index][0] === points[start][0] && points[index][1] < points[start][1])) start = index;
  }
  return [...points.slice(start), ...points.slice(0, start)];
}

function canonicalPolygons(polygons: readonly Polygon[]): Array<{outer: Point[]; holes: Point[][]}> {
  return polygons.map(polygon => ({
    outer: canonicalRing(polygon[0]),
    holes: polygon.slice(1).map(canonicalRing).sort(compareRings)
  })).sort((left, right) => compareRings(left.outer, right.outer));
}

function contains(ring: Point[], [x, y]: Point): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index];
    const [xp, yp] = ring[previous];
    if ((yi > y) !== (yp > y) && x < (xp - xi) * (y - yi) / (yp - yi) + xi) inside = !inside;
  }
  return inside;
}

function metrics(polygons: Polygon[]): Metrics {
  let rings = 0;
  let area = 0;
  let bbox: Metrics['bbox'] = null;
  for (const polygon of polygons) {
    rings += polygon.length;
    area += ringArea(polygon[0]) - polygon.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0);
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        bbox = bbox
          ? [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)]
          : [x, y, x, y];
      }
    }
  }
  return {components: polygons.length, rings, area, bbox};
}

/**
 * Frozen metrics captured from the vendored polygon-clipping 0.15.7 oracle
 * before it was removed from the production tree (2026-11-21). Keeping the
 * numbers here preserves the migration guard without shipping a second
 * boolean implementation.
 *
 * 可复现性：重新冻结时在临时目录安装固定版本 `npm pack polygon-clipping@0.15.7`，
 * 用同一组 shapes 跑 union/intersect/subtract 后记录 area/rings/components/bbox。
 * 随机矩形用例用解析面积做独立 oracle，不依赖这份冻结值。
 */
const cases: Array<{
  name: string;
  operation: 'union' | 'intersect' | 'subtract';
  shapes: Shape[];
  expected: Metrics;
  topology?: Polygon[];
}> = [
  {name: 'union overlapping rectangles', operation: 'union', shapes: [rect(0, 0, 10, 10), rect(5, 0, 15, 10)],
    expected: {components: 1, rings: 1, area: 150, bbox: [0, 0, 15, 10]},
    topology: [[[[0, 0], [15, 0], [15, 10], [0, 10]]]]},
  {name: 'intersect overlapping rectangles', operation: 'intersect', shapes: [rect(0, 0, 10, 10), rect(5, 5, 15, 15)],
    expected: {components: 1, rings: 1, area: 25, bbox: [5, 5, 10, 10]}},
  {name: 'subtract a circular hole', operation: 'subtract', shapes: [rect(0, 0, 20, 20), circle(10, 10, 4)],
    expected: {components: 1, rings: 2, area: 350.0568775638711, bbox: [0, 0, 20, 20]}},
  {name: 'subtract an inner rectangular hole', operation: 'subtract', shapes: [rect(0, 0, 20, 20), rect(5, 5, 15, 15)],
    expected: {components: 1, rings: 2, area: 300, bbox: [0, 0, 20, 20]},
    topology: [[[[0, 0], [20, 0], [20, 20], [0, 20]], [[5, 5], [15, 5], [15, 15], [5, 15]]]]},
  {name: 'subtract leaves a notch', operation: 'subtract', shapes: [rect(0, 0, 20, 20), rect(15, 5, 30, 15)],
    expected: {components: 1, rings: 1, area: 350, bbox: [0, 0, 20, 20]},
    topology: [[[[0, 0], [20, 0], [20, 5], [15, 5], [15, 15], [20, 15], [20, 20], [0, 20]]]]},
  {name: 'union of disjoint blocks', operation: 'union', shapes: [rect(0, 0, 10, 10), rect(100, 0, 110, 10)],
    expected: {components: 2, rings: 2, area: 200, bbox: [0, 0, 110, 10]},
    topology: [
      [[[0, 0], [10, 0], [10, 10], [0, 10]]],
      [[[100, 0], [110, 0], [110, 10], [100, 10]]]
    ]},
  {name: 'three-way union', operation: 'union', shapes: [rect(0, 0, 10, 10), rect(8, 0, 18, 10), rect(16, 0, 26, 10)],
    expected: {components: 1, rings: 1, area: 260, bbox: [0, 0, 26, 10]},
    topology: [[[[0, 0], [26, 0], [26, 10], [0, 10]]]]},
  {name: 'union of overlapping circles', operation: 'union', shapes: [circle(0, 0, 10), circle(10, 0, 10)],
    expected: {components: 1, rings: 1, area: 502.7745581368958, bbox: [-10, -10, 20, 10]}},
  {name: 'intersection of overlapping circles', operation: 'intersect', shapes: [circle(0, 0, 10), circle(10, 0, 10)],
    expected: {components: 1, rings: 1, area: 121.51447231471472, bbox: [0, -8.611725206789028, 10, 8.61172520678903]}},
  {name: 'subtract two circular holes', operation: 'subtract',
    shapes: [rect(0, 0, 30, 20), circle(8, 10, 4), circle(22, 10, 4)],
    expected: {components: 1, rings: 3, area: 500.11375512774225, bbox: [0, 0, 30, 20]}},
  {name: 'union keeps a hole from a previous result', operation: 'union',
    shapes: [
      path([[
        [[0, 0], [20, 0], [20, 20], [0, 20]],
        [[6, 6], [6, 14], [14, 14], [14, 6]]
      ]]),
      rect(30, 0, 40, 10)
    ],
    expected: {components: 2, rings: 3, area: 436, bbox: [0, 0, 40, 20]},
    topology: [
      [[[0, 0], [20, 0], [20, 20], [0, 20]], [[6, 6], [14, 6], [14, 14], [6, 14]]],
      [[[30, 0], [40, 0], [40, 10], [30, 10]]]
    ]},
  {name: 'subtract a previous disjoint result', operation: 'subtract',
    shapes: [
      rect(0, 0, 40, 20),
      path([
        [[[4, 4], [10, 4], [10, 10], [4, 10]]],
        [[[24, 4], [30, 4], [30, 10], [24, 10]]]
      ])
    ],
    expected: {components: 1, rings: 3, area: 728, bbox: [0, 0, 40, 20]},
    topology: [[
      [[0, 0], [40, 0], [40, 20], [0, 20]],
      [[4, 4], [10, 4], [10, 10], [4, 10]],
      [[24, 4], [30, 4], [30, 10], [24, 10]]
    ]]},
  {name: 'union merges a shared edge', operation: 'union', shapes: [rect(0, 0, 10, 10), rect(10, 0, 20, 10)],
    expected: {components: 1, rings: 1, area: 200, bbox: [0, 0, 20, 10]},
    topology: [[[[0, 0], [20, 0], [20, 10], [0, 10]]]]},
  {name: 'union of two rectangles forms a concave L', operation: 'union',
    shapes: [rect(0, 0, 10, 4), rect(0, 4, 4, 10)],
    expected: {components: 1, rings: 1, area: 64, bbox: [0, 0, 10, 10]},
    topology: [[[[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]]]},
  {name: 'intersection of disjoint shapes is empty', operation: 'intersect',
    shapes: [rect(0, 0, 10, 10), rect(20, 0, 30, 10)],
    expected: {components: 0, rings: 0, area: 0, bbox: null}},
  {name: 'subtracting an identical shape is empty', operation: 'subtract',
    shapes: [rect(0, 0, 10, 10), rect(0, 0, 10, 10)],
    expected: {components: 0, rings: 0, area: 0, bbox: null}}
];

/** 轴对齐矩形用解析面积做独立 oracle，覆盖冻结夹具之外的随机输入。 */
function randomRects(seed: number, count: number): Array<{a: RectShape; b: RectShape}> {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const rectAt = (id: string, x: number, y: number, width: number, height: number): RectShape => ({
    ...rect(x, y, x + width, y + height), id
  });
  return Array.from({length: count}, (_, index) => {
    const ax = Math.floor(next() * 80);
    const ay = Math.floor(next() * 80);
    const bx = Math.floor(next() * 80);
    const by = Math.floor(next() * 80);
    return {
      a: rectAt(`a-${index}`, ax, ay, 1 + Math.floor(next() * 30), 1 + Math.floor(next() * 30)),
      b: rectAt(`b-${index}`, bx, by, 1 + Math.floor(next() * 30), 1 + Math.floor(next() * 30))
    };
  });
}

function rectMetrics(shape: RectShape): {area: number; left: number; right: number; top: number; bottom: number} {
  const left = Math.min(shape.a[0], shape.b[0]);
  const right = Math.max(shape.a[0], shape.b[0]);
  const top = Math.min(shape.a[1], shape.b[1]);
  const bottom = Math.max(shape.a[1], shape.b[1]);
  return {area: (right - left) * (bottom - top), left, right, top, bottom};
}

function overlapArea(left: RectShape, right: RectShape): number {
  const a = rectMetrics(left);
  const b = rectMetrics(right);
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function areaOf(polygons: Polygon[] | undefined): number {
  return polygons ? metrics(polygons).area : 0;
}

describe('boolean kernel randomized area invariants', () => {
  const pairs = randomRects(0x5eed, 30);

  for (const {a, b} of pairs) {
    const areaA = rectMetrics(a).area;
    const areaB = rectMetrics(b).area;
    const overlap = overlapArea(a, b);

    test(`union/intersect/subtract areas match analytic rects (${a.id}/${b.id})`, () => {
      expect(Math.abs(areaOf(booleanShapes('union', [a, b])?.polygons) - (areaA + areaB - overlap)))
        .toBeLessThanOrEqual(1e-6);
      expect(Math.abs(areaOf(booleanShapes('intersect', [a, b])?.polygons) - overlap))
        .toBeLessThanOrEqual(1e-6);
      expect(Math.abs(areaOf(booleanShapes('subtract', [a, b])?.polygons) - (areaA - overlap)))
        .toBeLessThanOrEqual(1e-6);
    });
  }

  test('re-entrant results stay idempotent and subtractive', () => {
    for (const {a, b} of pairs.slice(0, 10)) {
      const merged = booleanShapes('union', [a, b])?.polygons ?? [];
      const mergedArea = areaOf(merged);
      const reuse = path(merged.map(polygon => polygon.map(ring => ring.map(([x, y]) => [x, y] as Point))));
      const again = booleanShapes('union', [reuse, a]);
      expect(Math.abs(areaOf(again?.polygons) - mergedArea)).toBeLessThanOrEqual(1e-6);
      const removed = booleanShapes('subtract', [reuse, a]);
      expect(Math.abs(areaOf(removed?.polygons) - (mergedArea - rectMetrics(a).area)))
        .toBeLessThanOrEqual(1e-6);
      expect(booleanShapes('subtract', [reuse, reuse])).toBeNull();
    }
  });
});

describe('boolean kernel against the frozen legacy oracle', () => {
  for (const {name, operation, shapes, expected, topology} of cases) {
    test(name, () => {
      const result = booleanShapes(operation, shapes);
      const actualPolygons = result?.polygons ?? [];
      const actualMetrics = metrics(actualPolygons);
      const expectedMetrics = expected;

      // 环闭合/无重复相邻点/无零面积碎片 + 外环 CCW、孔洞 CW、孔洞位于外环内部：
      // 面积指标之外防止内核返回退化或挂错 owner 的拓扑（圆形用例同样生效）。
      for (const polygon of actualPolygons) {
        expect(signedArea(polygon[0])).toBeGreaterThan(1e-9);
        for (const hole of polygon.slice(1)) {
          expect(signedArea(hole)).toBeLessThan(-1e-9);
          expect(contains(polygon[0], hole[0])).toBe(true);
        }
        for (const ring of polygon) {
          expect(ring.length).toBeGreaterThanOrEqual(3);
          for (let index = 0; index < ring.length; index++) {
            expect(ring[index]).not.toEqual(ring[(index + 1) % ring.length]);
          }
          expect(ringArea(ring)).toBeGreaterThan(1e-9);
        }
      }

      expect(actualMetrics.components).toBe(expectedMetrics.components);
      expect(actualMetrics.rings).toBe(expectedMetrics.rings);
      expect(Math.abs(actualMetrics.area - expectedMetrics.area)).toBeLessThanOrEqual(TOLERANCE);
      if (!expectedMetrics.bbox) {
        expect(actualMetrics.bbox).toBeNull();
      } else {
        expect(actualMetrics.bbox).not.toBeNull();
        for (let index = 0; index < 4; index++) {
          expect(Math.abs(actualMetrics.bbox![index] - expectedMetrics.bbox[index])).toBeLessThanOrEqual(TOLERANCE);
        }
      }
      if (topology) expect(canonicalPolygons(actualPolygons)).toEqual(canonicalPolygons(topology));
    });
  }
});
