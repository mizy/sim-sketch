import {readFileSync} from 'node:fs';
import {beforeAll, describe, expect, test, vi} from 'vitest';
import {booleanShapes} from '../geometry.ts';
import type {Point, Polygon, RectShape} from '../geometry.ts';
import {INSTANCE_FLOATS, buildFillGeometry, packPrimitives} from '../gpu-scene.ts';
import type {GpuFillOp} from '../gpu-scene.ts';
import type {RenderPrimitive} from '../renderer.ts';
import {GeometryKernelNotReadyError, initGeometryKernel, tessellatePolygons} from '../kernel.ts';

beforeAll(async () => {
  await initGeometryKernel(readFileSync(new URL('../wasm/pkg/sim_sketch_geometry.wasm', import.meta.url)));
});

const rect = (x1: number, y1: number, x2: number, y2: number): RectShape => ({
  id: 'rect', type: 'rect', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4, a: [x1, y1], b: [x2, y2]
});

const fillOp = (polygons: Polygon[]): GpuFillOp => ({
  kind: 'fill', polygons, color: [0.18, 0.31, 0.47, 1], opacity: 1, depth: .5, translucent: false
});

function ringArea(ring: readonly Point[]): number {
  let total = 0;
  for (let index = 0; index < ring.length; index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    total += x1 * y2 - x2 * y1;
  }
  return Math.abs(total) / 2;
}

function polygonArea(polygons: readonly Polygon[]): number {
  return polygons.reduce((sum, polygon) =>
    sum + ringArea(polygon[0]) - polygon.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0), 0);
}

function ringContains(ring: readonly Point[], [x, y]: Point): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index];
    const [xp, yp] = ring[previous];
    if ((yi > y) !== (yp > y) && x < (xp - xi) * (y - yi) / (yp - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd membership mirrors Canvas2D `fill('evenodd')` and the SVG default. */
function polygonsContain(polygons: readonly Polygon[], point: Point): boolean {
  let inside = false;
  for (const polygon of polygons) for (const ring of polygon) {
    if (ringContains(ring, point)) inside = !inside;
  }
  return inside;
}

function triangleContains(a: Point, b: Point, c: Point, [x, y]: Point): boolean {
  const cross = (p: Point, q: Point, r: Point): number =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const ab = cross(a, b, [x, y]);
  const bc = cross(b, c, [x, y]);
  const ca = cross(c, a, [x, y]);
  return (ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0);
}

function triangleArea(triangles: Float32Array): number {
  let total = 0;
  for (let index = 0; index < triangles.length; index += 6) {
    const [ax, ay] = [triangles[index], triangles[index + 1]];
    const [bx, by] = [triangles[index + 2], triangles[index + 3]];
    const [cx, cy] = [triangles[index + 4], triangles[index + 5]];
    total += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  return total;
}

function triangleParity(triangles: Float32Array, x: number, y: number): boolean {
  let inside = false;
  for (let index = 0; index < triangles.length; index += 6) {
    if (triangleContains(
      [triangles[index], triangles[index + 1]],
      [triangles[index + 2], triangles[index + 3]],
      [triangles[index + 4], triangles[index + 5]],
      [x, y]
    )) inside = !inside;
  }
  return inside;
}

/** 避开三角化接缝：点在共享边上会被相邻两个三角形同时计数，无法模拟 GPU 的 top-left 规则。 */
const samples: Point[] = [
  [1.1, 2.6], [2.2, 2.3], [9.1, 3.2], [1.1, 5.2], [3.2, 9.1], [5.2, 5.3],
  [9.2, 9.1], [-1, 2.5], [11.2, 2.1], [2.1, -1]
];

describe('WebGPU fill geometry', () => {
  test('L-shaped union is triangulated without fan overlap holes', () => {
    const output = booleanShapes('union', [rect(0, 0, 10, 4), rect(0, 4, 4, 10)]);
    expect(output).not.toBeNull();
    const polygons = output!.polygons;
    const geometry = buildFillGeometry([fillOp(polygons)]);
    expect(geometry.needsKernel).toBe(false);
    expect(geometry.triangles.length).toBeGreaterThan(0);

    // 旧 triangle-fan 实现会在 (1, 2.5) 记录偶数次覆盖而漏填。
    for (const point of samples) {
      expect(triangleParity(geometry.triangles, point[0], point[1])).toBe(polygonsContain(polygons, point));
    }
    expect(triangleArea(geometry.triangles)).toBeCloseTo(polygonArea(polygons), 4);
  });

  test('holes stay empty and outer area matches the boolean result', () => {
    const output = booleanShapes('subtract', [rect(0, 0, 20, 20), rect(5, 5, 15, 15)]);
    expect(output).not.toBeNull();
    const polygons = output!.polygons;
    const geometry = buildFillGeometry([fillOp(polygons)]);

    expect(polygonsContain(polygons, [10, 10])).toBe(false);
    expect(triangleParity(geometry.triangles, 10, 10)).toBe(false);
    expect(triangleParity(geometry.triangles, 2.1, 2.2)).toBe(true);
    expect(triangleParity(geometry.triangles, 17.9, 18.1)).toBe(true);
  });

  test('multiple concave components keep independent draw ranges', () => {
    const first = booleanShapes('union', [rect(0, 0, 10, 4), rect(0, 4, 4, 10)])!;
    const moved = first.polygons.map(polygon => polygon.map(ring =>
      ring.map(([x, y]) => [x + 20, y] as Point)));
    const geometry = buildFillGeometry([fillOp(first.polygons), fillOp(moved)]);
    expect(geometry.ranges.size).toBe(2);
    expect(geometry.vertices).toHaveLength(geometry.triangles.length / 2 * 7);
    expect(triangleParity(geometry.triangles, 1.1, 2.6)).toBe(true);
    expect(triangleParity(geometry.triangles, 21.1, 2.6)).toBe(true);
    expect(triangleParity(geometry.triangles, 15.1, 2.6)).toBe(false);
  });

  test('a missing kernel is reported instead of silently drawing an empty fill', () => {
    const geometry = buildFillGeometry([fillOp([[[[0, 0], [10, 0], [10, 10]]]])],
      () => { throw new GeometryKernelNotReadyError(); });
    expect(geometry.needsKernel).toBe(true);
    expect(geometry.triangles).toHaveLength(0);
    expect(geometry.ranges.size).toBe(0);
  });

  test('generic tessellator errors propagate so the host can fall back', () => {
    expect(() => buildFillGeometry([fillOp([[[[0, 0], [10, 0], [10, 10]]]])],
      () => { throw new Error('tessellator bug'); })).toThrow('tessellator bug');
  });

  test('out-of-range tessellation indices are rejected instead of becoming empty fills', () => {
    expect(() => buildFillGeometry([fillOp([[[[0, 0], [10, 0], [10, 10]]]])],
      () => ({positions: new Float32Array([0, 0, 10, 0, 10, 10]), indices: new Uint32Array([0, 1, 9])})))
      .toThrow(/越界索引/);
  });

  test('multiple holes stay empty without overlapping triangles', () => {
    // Review regression: two holes used to produce overlapping ears (area 4567,
    // second hole filled). Scanline even-odd must keep both holes empty.
    const polygons: Polygon[] = [[
      [[0, 0], [80, 0], [80, 53], [0, 53]],
      [[8, 3], [23, 3], [23, 9], [8, 9]],
      [[18, 32], [33, 32], [33, 44], [18, 44]]
    ]];
    const geometry = buildFillGeometry([fillOp(polygons)]);
    expect(polygonArea(polygons)).toBe(3970);
    expect(triangleArea(geometry.triangles)).toBeCloseTo(3970, 4);
    expect(triangleParity(geometry.triangles, 25, 35)).toBe(false);
    expect(triangleParity(geometry.triangles, 15, 6)).toBe(false);
    expect(triangleParity(geometry.triangles, 15, 35)).toBe(true);
    expect(triangleParity(geometry.triangles, 70, 45)).toBe(true);
  });

  test('fill and stroke draw ops keep primitive painter order', () => {
    const color: [number, number, number, number] = [0, 0, 0, 1];
    const primitives: RenderPrimitive[] = [
      {kind: 'stroke', layerId: 'layer', points: [[0, 0], [5, 5], [10, 10]], color, width: 2},
      {kind: 'fill', layerId: 'layer', polygons: [[[[2, 2], [8, 2], [8, 8]]]], color, opacity: 1},
      {kind: 'stroke', layerId: 'layer', points: [[10, 0], [0, 10]], color, width: 2}
    ];
    const packed = packPrimitives(primitives, 1);
    expect(packed.ops.map(op => op.kind)).toEqual(['stroke', 'fill', 'stroke']);
    // 后画的 fill 深度更小；渲染器先提交描边批次，再让半透明填充通过深度测试叠上去。
    expect(packed.ops[1].depth).toBeLessThan(packed.ops[0].depth);
    expect(packed.ops[2].depth).toBeLessThan(packed.ops[1].depth);
    expect(packed.instances.length % INSTANCE_FLOATS).toBe(0);
  });

  test('halo and ink split into painter-ordered opaque/translucent batches', () => {
    const accent: [number, number, number, number] = [.188, .278, .8, .16];
    const ink: [number, number, number, number] = [1, 0, 0, 1];
    const primitives: RenderPrimitive[] = [
      {kind: 'stroke', layerId: 'layer', points: [[0, 5], [10, 5]], color: accent, width: 12},
      {kind: 'stroke', layerId: 'layer', points: [[0, 5], [10, 5]], color: ink, width: 4},
      {kind: 'ellipse', layerId: 'layer', center: [5, 5], radii: [3, 3], color: accent, width: 12},
      {kind: 'ellipse', layerId: 'layer', center: [5, 5], radii: [3, 3], color: ink, width: 4, fill: .12},
      {kind: 'marker', layerId: 'layer', marker: {kind: 'grid', point: [5, 5]}, color: ink}
    ];
    const packed = packPrimitives(primitives, 2);
    // 透明度切换必须断批：光晕/半透明椭圆进 translucent pass，墨色与标记进 opaque pass。
    expect(packed.ops.map(op => op.kind)).toEqual(['stroke', 'stroke', 'stroke', 'stroke']);
    expect(packed.ops.map(op => op.kind === 'stroke' && op.translucent))
      .toEqual([true, false, true, false]);
    const total = packed.ops.reduce((sum, op) => sum + (op.kind === 'stroke' ? op.count : 1), 0);
    expect(total).toBe(10);
    expect(packed.instances.length).toBe(total * INSTANCE_FLOATS);
    // 实例顺序仍保持 painter 顺序，深度严格递减。
    const depths = Array.from({length: total}, (_, index) =>
      packed.instances[index * INSTANCE_FLOATS + INSTANCE_FLOATS - 1]);
    for (let index = 1; index < depths.length; index++) {
      expect(depths[index]).toBeLessThan(depths[index - 1]);
    }
  });

  test('reuses tessellation when the same shape polygons are projected again', () => {
    const op = fillOp(booleanShapes('union', [rect(0, 0, 10, 4), rect(0, 4, 4, 10)])!.polygons);
    const tessellate = vi.fn(tessellatePolygons);
    const first = buildFillGeometry([op], tessellate);
    const second = buildFillGeometry([op], tessellate);
    expect(tessellate).toHaveBeenCalledTimes(1);
    expect(second.triangles).toEqual(first.triangles);
  });
});
