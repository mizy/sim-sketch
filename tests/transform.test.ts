import {readFileSync} from 'node:fs';
import {beforeAll, describe, expect, test} from 'vitest';
import {booleanShapes, polygonArea, rectCorners, shapePath, shapePoints, shapeRings} from '../geometry.ts';
import type {ArcShape, CircleShape, Point, RectShape} from '../geometry.ts';
import {initGeometryKernel} from '../kernel.ts';
import type {RegionMark, TextMark} from '../project.ts';
import {
  applyMatrix,
  boundsFromPoints,
  frameHandlePoint,
  frameHandles,
  frameScaleFactors,
  frameScaleMatrix,
  rotationMatrix,
  scaleMatrix,
  selectionBounds,
  selectionFrame,
  snapAngle,
  snapRotationDelta,
  transformMark,
  transformShape
} from '../transform.ts';

beforeAll(async () => {
  await initGeometryKernel(readFileSync(new URL('../wasm/pkg/sim_sketch_geometry.wasm', import.meta.url)));
});

const base = {layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4};
const rect = (x1: number, y1: number, x2: number, y2: number, rotation?: number): RectShape => ({
  ...base, id: 'rect', type: 'rect', a: [x1, y1], b: [x2, y2], ...(rotation === undefined ? {} : {rotation})
});
const circle = (x: number, y: number, radius: number): CircleShape => ({
  ...base, id: 'circle', type: 'circle', center: [x, y], radius
});
const arc = (): ArcShape => ({
  ...base, id: 'arc', type: 'arc', points: [[0, 10], [10, 0], [20, 10]]
});

describe('transform matrices', () => {
  test('scale and rotation keep the pivot fixed', () => {
    const scaled = scaleMatrix([10, 20], 2, 3);
    expect(applyMatrix([10, 20], scaled)).toEqual([10, 20]);
    expect(applyMatrix([20, 30], scaled)).toEqual([30, 50]);

    const rotated = rotationMatrix([10, 20], Math.PI / 2);
    const [x, y] = applyMatrix([20, 20], rotated);
    expect(x).toBeCloseTo(10, 9);
    expect(y).toBeCloseTo(30, 9);
  });

  test('rotation snaps to 15 degree steps', () => {
    expect(snapAngle(7 * Math.PI / 180) * 180 / Math.PI).toBeCloseTo(0, 9);
    expect(snapAngle(8 * Math.PI / 180) * 180 / Math.PI).toBeCloseTo(15, 9);
    expect(snapAngle(-23 * Math.PI / 180) * 180 / Math.PI).toBeCloseTo(-30, 9);
  });

  test('corner scaling uses the opposite corner as pivot and can be uniform', () => {
    const frame = selectionFrame({shapes: [rect(0, 0, 100, 100)], marks: []})!;
    expect(frameScaleFactors(frame, 'se', [150, 150], false)).toEqual({sx: 1.5, sy: 1.5});
    expect(frameScaleFactors(frame, 'se', [150, 110], false)).toEqual({sx: 1.5, sy: 1.1});
    expect(frameScaleFactors(frame, 'se', [150, 110], true)).toEqual({sx: 1.5, sy: 1.5});
    // 不允许越过对角点翻转，停在对象类型的最小尺寸。
    expect(frameScaleFactors(frame, 'se', [-50, -50], false)).toEqual({sx: .04, sy: .04});
  });
});

describe('rotated rectangle geometry', () => {
  test('rotation changes path, points and boolean rings together', () => {
    const shape = rect(0, 0, 10, 10, 45);
    const path = shapePath(shape);
    expect(path).toContain('L');
    expect(path).not.toContain('H');
    expect(shapePoints(shape)).toEqual(rectCorners(shape));
    expect((shapeRings(shape) as Point[][])[0]).toEqual(rectCorners(shape));

    const bounds = selectionBounds({shapes: [shape], marks: []})!;
    expect(bounds.max[0] - bounds.min[0]).toBeCloseTo(Math.SQRT2 * 10, 6);
    expect(bounds.max[1] - bounds.min[1]).toBeCloseTo(Math.SQRT2 * 10, 6);
  });

  test('selection bounds append dense path points without spread overflow', () => {
    const points = Array.from({length: 200_000}, (_, index) => [index, index % 7] as Point);
    const dense = {id: 'dense', type: 'path' as const, ...base, polygons: [[points]]};
    const bounds = selectionBounds({shapes: [dense], marks: []})!;
    expect(bounds.min).toEqual([0, 0]);
    expect(bounds.max).toEqual([199_999, 6]);
  });

  test('rotated rectangle participates in boolean with its real ring', () => {
    const shape = rect(0, 0, 10, 10, 45);
    const result = booleanShapes('intersect', [shape, shape]);
    expect(result?.polygons).toHaveLength(1);
    expect(polygonArea(result!.polygons[0][0])).toBeCloseTo(100, 3);
  });

  test('pure rotation keeps the rect representation and adds the angle', () => {
    const shape = rect(0, 0, 10, 10, 30);
    const next = transformShape(shape, rotationMatrix([5, 5], Math.PI / 6)) as RectShape;
    expect(next.type).toBe('rect');
    expect(next.rotation).toBeCloseTo(60, 9);
    expect(next.a[0]).toBeCloseTo(0, 9);
    expect(next.a[1]).toBeCloseTo(0, 9);
  });

  test('local-axis scaling keeps a rotated rect as rect and preserves rotation', () => {
    const shape = rect(0, 0, 100, 50, 30);
    const frame = selectionFrame({shapes: [shape], marks: []})!;
    const factors = frameScaleFactors(frame, 'se', [80, 60], false);
    const next = transformShape(shape, frameScaleMatrix(frame, factors.sx, factors.sy, 'se'));
    expect(next?.type).toBe('rect');
    if (next?.type !== 'rect') throw new Error('expected rect');
    expect(next.rotation).toBeCloseTo(30, 9);
    expect((next as {rotation?: number}).rotation).toBeDefined();
    // 对边（nw）锚点世界坐标不动。
    const beforeNW = rectCorners(shape)[0];
    const afterNW = rectCorners(next)[0];
    expect(afterNW[0]).toBeCloseTo(beforeNW[0], 6);
    expect(afterNW[1]).toBeCloseTo(beforeNW[1], 6);
  });

  test('world-axis shear cannot be represented and is rejected instead of becoming path', () => {
    const shape = rect(0, 0, 100, 50, 30);
    expect(transformShape(shape, scaleMatrix([0, 0], 2, 1))).toBeNull();
  });
});

describe('transform frame', () => {
  test('rect exposes 8 handles and follows its own rotation', () => {
    const frame = selectionFrame({shapes: [rect(0, 0, 100, 50, 30)], marks: []})!;
    expect(frameHandles(frame)).toHaveLength(8);
    expect(frameHandles(frame)).toEqual(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
    expect(frame.rotation).toBeCloseTo(Math.PI / 6, 9);
    expect(frame.rotatable).toBe(true);
  });

  test('circle frame is uniform without a rotate handle; text is move-only', () => {
    const circleFrame = selectionFrame({shapes: [circle(10, 10, 5)], marks: []})!;
    expect(circleFrame.mode).toBe('uniform');
    expect(circleFrame.rotatable).toBe(false);
    expect(frameHandles(circleFrame)).toEqual(['nw', 'ne', 'se', 'sw']);

    const arcFrame = selectionFrame({shapes: [arc()], marks: []})!;
    expect(arcFrame.mode).toBe('uniform');
    expect(arcFrame.rotatable).toBe(true);
    expect(frameHandles(arcFrame)).toEqual(['nw', 'ne', 'se', 'sw']);

    const text: TextMark = {id: 'text', shape: 'text', kind: 'note', label: '载荷', value: 10, unit: 'N',
      direction: '', question: '', confirmed: false, source: 'manual', layerId: 'layer', a: [10, 20]};
    const textFrame = selectionFrame({shapes: [], marks: [text]})!;
    expect(textFrame.mode).toBe('none');
    expect(textFrame.rotatable).toBe(false);
    expect(frameHandles(textFrame)).toEqual([]);
  });

  test('mixed selections only expose handles the contents can actually use', () => {
    const plain = rect(200, 0, 300, 50);
    const rotated = rect(0, 0, 100, 50, 30);
    const mixed = selectionFrame({shapes: [rotated, plain], marks: []})!;
    expect(mixed.mode).toBe('uniform');
    expect(frameHandles(mixed)).toEqual(['nw', 'ne', 'se', 'sw']);

    // 90° 旋转矩形与世界轴缩放仍保持正交，可以保留 8 个手柄。
    const aligned = selectionFrame({shapes: [rect(0, 0, 100, 50, 90), plain], marks: []})!;
    expect(aligned.mode).toBe('free');
    expect(frameHandles(aligned)).toHaveLength(8);

    const withCircle = selectionFrame({shapes: [circle(0, 0, 10), plain], marks: []})!;
    expect(withCircle.mode).toBe('uniform');

    const text: TextMark = {id: 'text', shape: 'text', kind: 'note', label: '说明', value: null, unit: '',
      direction: '', question: '', confirmed: false, source: 'manual', layerId: 'layer', a: [10, 20]};
    const withText = selectionFrame({shapes: [plain], marks: [text]})!;
    expect(withText.rotatable).toBe(false);
  });

  test('region frame and minimum scale share the rendered radius floor', () => {
    const tiny: RegionMark = {id: 'tiny', shape: 'region', kind: 'note', label: '', value: null, unit: '',
      direction: '', question: '', confirmed: false, source: 'manual', layerId: 'layer', a: [0, 0], b: [1, 1]};
    const frame = selectionFrame({shapes: [], marks: [tiny]})!;
    expect(frame.half).toEqual([3, 3]);
    expect(frame.minExtent).toEqual([6, 6]);

    const shrunk = transformMark(tiny, scaleMatrix([0, 0], .1, .1)) as RegionMark;
    expect(Math.abs(shrunk.b[0] - shrunk.a[0]) / 2).toBeCloseTo(3, 9);
    expect(Math.abs(shrunk.b[1] - shrunk.a[1]) / 2).toBeCloseTo(3, 9);
  });

  test('Shift rotation snaps the absolute angle, not the gesture delta', () => {
    const start = 7 * Math.PI / 180;
    // 7° + 8° = 15°，命中绝对网格时增量恰好是 8°。
    expect(snapRotationDelta(start, 8 * Math.PI / 180) * 180 / Math.PI).toBeCloseTo(8, 9);
    // 7° + 20° = 27° → 30°，增量为 23°，而不是把 20° 吸到 15°/30°。
    expect(snapRotationDelta(start, 20 * Math.PI / 180) * 180 / Math.PI).toBeCloseTo(23, 9);
  });

  test('minimum size clamps scale factors, including circle radius 1', () => {
    const frame = selectionFrame({shapes: [circle(0, 0, 10)], marks: []})!;
    const factors = frameScaleFactors(frame, 'se', [-100, -100], false);
    // 直径 20 收缩到最小 2（半径 1）。
    expect(factors.sx).toBeCloseTo(0.1, 6);
    expect(factors.sy).toBeCloseTo(0.1, 6);

    const small = selectionFrame({shapes: [rect(0, 0, 100, 50)], marks: []})!;
    const rectFactors = frameScaleFactors(small, 'se', [-100, -100], false);
    // 100×50 收缩到最小 4×4。
    expect(rectFactors.sx).toBeCloseTo(0.04, 6);
    expect(rectFactors.sy).toBeCloseTo(0.08, 6);
  });

  test('small objects keep their real pivot and minimum size despite handle padding', () => {
    const shape = rect(100, 150, 110, 154);
    const frame = selectionFrame({shapes: [shape], marks: []}, 14)!;
    // padding 只扩展手柄，不改变几何 frame。
    expect(frame.half).toEqual([5, 2]);
    expect(frame.handleHalf).toEqual([7, 7]);
    const grab = frameHandlePoint(frame, 'se');
    expect(grab).toEqual([112, 159]);

    // 在原手柄外扩位置按下、尚未移动时不产生 1.2×/2.25× 的跳变。
    expect(frameScaleFactors(frame, 'se', grab, false, grab)).toEqual({sx: 1, sy: 1});

    // 向内收缩：宽夹到 4，高保持原始 4；nw 锚点仍在 (100,150)。
    const factors = frameScaleFactors(frame, 'se', [80, 152], false, grab);
    expect(factors.sx).toBeCloseTo(0.4, 9);
    expect(factors.sy).toBeCloseTo(1, 9);
    const next = transformShape(shape,
      frameScaleMatrix(frame, factors.sx, factors.sy, 'se')) as RectShape;
    expect(next.a[0]).toBeCloseTo(100, 6);
    expect(next.a[1]).toBeCloseTo(150, 6);
    expect(next.b[0] - next.a[0]).toBeCloseTo(4, 6);
    expect(next.b[1] - next.a[1]).toBeCloseTo(4, 6);

    // 比产品下限还小的旧对象也不能在按下瞬间被“夹取放大”。
    const tiny = selectionFrame({shapes: [rect(0, 0, 2, 2)], marks: []}, 14)!;
    const tinyGrab = frameHandlePoint(tiny, 'se');
    expect(frameScaleFactors(tiny, 'se', tinyGrab, false, tinyGrab)).toEqual({sx: 1, sy: 1});
  });
});

describe('round shapes and marks', () => {
  test('circle and arc reject non-uniform scale and accept uniform scale', () => {
    expect(transformShape(circle(10, 10, 5), scaleMatrix([0, 0], 2, 1))).toBeNull();
    expect(transformShape(arc(), scaleMatrix([0, 0], 2, 1))).toBeNull();

    const scaled = transformShape(circle(10, 10, 5), scaleMatrix([0, 0], 2, 2)) as CircleShape;
    expect(scaled.radius).toBe(10);
    expect(scaled.center).toEqual([20, 20]);

    const rotated = transformShape(arc(), rotationMatrix([10, 10], Math.PI / 2)) as ArcShape;
    expect(rotated.type).toBe('arc');
    expect(rotated.points).toHaveLength(3);
  });

  test('region mark keeps an explicit rotation and scales uniformly', () => {
    const region: RegionMark = {id: 'region', shape: 'region', kind: 'note', label: '', value: null, unit: '',
      direction: '', question: '', confirmed: false, source: 'manual', layerId: 'layer',
      a: [0, 0], b: [20, 10], width: 3, rotation: 30};
    const next = transformMark(region, scaleMatrix([0, 0], 2, 2)) as RegionMark;
    expect(next.rotation).toBeCloseTo(30, 9);
    expect(next.b).toEqual([40, 20]);
    expect(transformMark(region, scaleMatrix([0, 0], 2, 1))).toBeNull();
  });

  test('text marks only move their anchor', () => {
    const text: TextMark = {id: 'text', shape: 'text', kind: 'note', label: '载荷', value: 10, unit: 'N',
      direction: '', question: '', confirmed: false, source: 'manual', layerId: 'layer', a: [10, 20]};
    const moved = transformMark(text, scaleMatrix([0, 0], 3, 2)) as TextMark;
    expect(moved.a).toEqual([30, 40]);
    expect(moved.label).toBe('载荷');
    expect((moved as TextMark & {fontSize?: number}).fontSize).toBeUndefined();
  });

  test('runtime-corrupted unknown marks cannot throw while building a selection frame', () => {
    const unknown = {id: 'bad', shape: 'bogus', layerId: 'layer', a: [0, 0]} as unknown as TextMark;
    expect(selectionBounds({shapes: [], marks: [unknown]})).toBeNull();
    expect(selectionFrame({shapes: [], marks: [unknown]})).toBeNull();
  });
});
