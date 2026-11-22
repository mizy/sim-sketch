import {readFileSync} from 'node:fs';
import {beforeAll, describe, expect, test} from 'vitest';
import {arcCircle, booleanShapes, canBoolean, shapePath, shapeRings, translateShape} from '../geometry.ts';
import type {CircleShape, Point, RectShape, Shape} from '../geometry.ts';
import {initGeometryKernel} from '../kernel.ts';

beforeAll(async () => {
  await initGeometryKernel(readFileSync(new URL('../wasm/pkg/sim_sketch_geometry.wasm', import.meta.url)));
});

const rect = (x1: number, y1: number, x2: number, y2: number): RectShape => ({
  id: 'rect', type: 'rect', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4, a: [x1, y1], b: [x2, y2]
});
const circle = (x: number, y: number, radius: number): CircleShape => ({
  id: 'circle', type: 'circle', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4, center: [x, y], radius
});

function area(ring: Point[]): number {
  let total = 0;
  for (let index = 0; index < ring.length; index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    total += x1 * y2 - x2 * y1;
  }
  return Math.abs(total) / 2;
}

describe('geometry', () => {
  test('closed primitives produce SVG paths and polygon rings', () => {
    expect(shapePath({id: 'line', type: 'line', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4,
      points: [[0, 0], [20, 10]]})).toBe('M0 0L20 10');
    expect(shapePath(rect(0, 0, 20, 10))).toMatch(/^M0 0H20V10H0Z$/);
    expect(shapePath(circle(10, 10, 5))).toMatch(/^M5 10A5 5 0 1 0 15 10/);
    expect(shapeRings(rect(0, 0, 20, 10))).toHaveLength(1);
    expect((shapeRings(circle(10, 10, 5)) as Point[][])[0].length).toBeGreaterThanOrEqual(32);
  });

  test('union merges overlapping rectangles into one ring', () => {
    const output = booleanShapes('union', [rect(0, 0, 10, 10), rect(5, 0, 15, 10)]);
    expect(output?.type).toBe('path');
    expect(output?.polygons).toHaveLength(1);
    expect(output?.polygons[0]).toHaveLength(1);
    expect(area(output!.polygons[0][0])).toBe(150);
  });

  test('subtract keeps a hole and intersection keeps only the overlap', () => {
    const hole = booleanShapes('subtract', [rect(0, 0, 20, 20), circle(10, 10, 4)]);
    expect(hole?.polygons).toHaveLength(1);
    expect(hole?.polygons[0]).toHaveLength(2);
    expect(area(hole!.polygons[0][0])).toBeGreaterThan(area(hole!.polygons[0][1]));

    const overlap = booleanShapes('intersect', [rect(0, 0, 10, 10), rect(5, 5, 15, 15)]);
    expect(overlap?.polygons).toHaveLength(1);
    expect(area(overlap!.polygons[0][0])).toBe(25);
  });

  test('boolean paths preserve disjoint components for later operations', () => {
    const combined = booleanShapes('union', [rect(0, 0, 10, 10), rect(100, 0, 110, 10)])!;
    expect(combined.polygons).toHaveLength(2);
    const next = booleanShapes('union', [combined as Shape, rect(5, 0, 15, 10)])!;
    expect(next.polygons).toHaveLength(2);
    const total = next.polygons.reduce((sum, polygon) =>
      sum + area(polygon[0]) - polygon.slice(1).reduce((holes, ring) => holes + area(ring), 0), 0);
    expect(total).toBe(250);
  });

  test('open shapes are excluded from boolean operations', () => {
    const line: Shape = {id: 'line', type: 'line', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4,
      points: [[0, 0], [10, 10]]};
    expect(canBoolean([line, rect(0, 0, 10, 10)])).toBe(false);
    expect(booleanShapes('union', [line, rect(0, 0, 10, 10)])).toBeNull();
  });

  test('three-point arcs resolve their circle and shapes translate without mutation', () => {
    const arc = arcCircle([[0, 10], [10, 0], [20, 10]]);
    expect(arc).not.toBeNull();
    expect(Math.abs(arc!.radius - 10)).toBeLessThan(1e-9);
    expect(arc!.center).toEqual([10, 10]);

    const source = rect(0, 0, 10, 10);
    expect((translateShape(source, 5, -3) as RectShape).a).toEqual([5, -3]);
    expect(source.a).toEqual([0, 0]);
  });

  test('lines translate through their points, not through rect corners', () => {
    const line: Shape = {id: 'line', type: 'line', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4,
      points: [[0, 0], [10, 0]]};
    expect((translateShape(line, 5, 3) as {points: Point[]}).points).toEqual([[5, 3], [15, 3]]);
  });
});
