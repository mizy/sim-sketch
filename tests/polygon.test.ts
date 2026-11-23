import {readFileSync} from 'node:fs';
import {beforeAll, describe, expect, test} from 'vitest';
import {
  booleanShapes,
  polygonArea,
  polygonHasPoint,
  polygonIssue,
  polygonRing,
  shapePath,
  shapeRings,
  translateShape
} from '../geometry.ts';
import type {PathShape, Point} from '../geometry.ts';
import {initGeometryKernel} from '../kernel.ts';
import type {Project} from '../project.ts';
import {buildScene} from '../scene.ts';

beforeAll(async () => {
  await initGeometryKernel(readFileSync(new URL('../wasm/pkg/sim_sketch_geometry.wasm', import.meta.url)));
});

const triangle: Point[] = [[0, 0], [20, 0], [0, 20]];

const polygon = (points: Point[] = triangle): PathShape => ({
  id: 'polygon', type: 'path', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4,
  polygons: [[points]], origin: points[0]
});

function area(ring: Point[]): number {
  return polygonArea(ring);
}

describe('free polygon geometry', () => {
  test('area and closure validation reject incomplete or degenerate drafts', () => {
    expect(area(triangle)).toBe(200);
    expect(polygonIssue([])).toBe('too-few');
    expect(polygonIssue([[0, 0], [10, 0]])).toBe('too-few');
    expect(polygonIssue([[0, 0], [10, 0], [10, 0]])).toBe('duplicate');
    expect(polygonIssue([[0, 0], [10, 0], [1, 0.1]])).toBe('degenerate');
    expect(polygonIssue(triangle)).toBeNull();
  });

  test('duplicate detection uses a small world tolerance', () => {
    expect(polygonHasPoint(triangle, [20.2, 0.1])).toBe(true);
    expect(polygonHasPoint(triangle, [20.6, 0.1])).toBe(false);
  });

  test('rings are rounded to the persisted path precision', () => {
    expect(polygonRing([[-0.0004, 1.23456], [10.5555, 2]])).toEqual([[0, 1.235], [10.556, 2]]);
  });

  test('polygon reuses the path render/boolean representation', () => {
    const shape = polygon();
    expect(shapePath(shape)).toBe('M0 0L20 0L0 20Z');
    expect(shapeRings(shape)).toEqual([[triangle]]);

    const union = booleanShapes('union', [shape, {
      id: 'rect', type: 'rect', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4,
      a: [10, 0], b: [30, 10]
    }]);
    expect(union?.polygons).toHaveLength(1);
    expect(area(union!.polygons[0][0])).toBeCloseTo(350, 6);
  });

  test('translation moves optional origin together with the polygon rings', () => {
    const moved = translateShape(polygon(), 5, -3) as PathShape;
    expect(moved.origin).toEqual([5, -3]);
    expect(moved.polygons[0][0]).toEqual([[5, -3], [25, -3], [5, 17]]);
  });

  test('polyline paths preserve every vertex for the drawing preview', () => {
    expect(shapePath({id: 'preview', type: 'line', layerId: 'layer', color: '#3047cc', strokeWidth: 1.5,
      points: [[1, 2], [3, 4], [5, 6]]})).toBe('M1 2L3 4L5 6');
  });

  test('the shared scene consumes polygons as one fill plus one closed stroke', () => {
    const project: Project = {
      reference: null,
      layers: [{id: 'layer', name: '图层 1', opacity: 1}],
      marks: [],
      shapes: [polygon()]
    };
    const scene = buildScene(project, {
      viewport: {x: 0, y: 0, width: 960, height: 600, cssWidth: 960, cssHeight: 600, dpr: 1,
        pixelsPerWorldUnit: 1}
    });
    const primitives = scene.layers[0].primitives;
    expect(primitives.map(item => item.kind)).toEqual(['fill', 'stroke']);
    const fill = primitives[0];
    const stroke = primitives[1];
    expect(fill.kind === 'fill' && fill.polygons[0][0]).toEqual(triangle);
    expect(stroke.kind === 'stroke' && stroke.closed).toBe(true);
    expect(stroke.kind === 'stroke' && stroke.points).toEqual(triangle);
  });
});
