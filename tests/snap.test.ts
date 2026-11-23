import {describe, expect, test} from 'vitest';
import {
  createSnapIndex,
  DEFAULT_SNAP_THRESHOLD_PX,
  MAX_SNAP_FEATURES,
  resolveSnap,
  snapEntities,
  snapThresholdWorld
} from '../snap.ts';
import type {SnapEntity, SnapOptions} from '../snap.ts';
import type {Project} from '../project.ts';
import {newShape} from '../geometry.ts';
import type {Shape} from '../geometry.ts';
import {constrainPoint, extendShape} from '../editor-drawing.ts';

const layer = {id: 'layer', name: '图层 1', opacity: 1};
const grid: SnapOptions['grid'] = {spacing: 24, origin: [0, 0]};

function options(scale = 1, extra: Partial<SnapOptions> = {}): SnapOptions {
  return {scale, thresholdPx: DEFAULT_SNAP_THRESHOLD_PX, grid: null, ...extra};
}

function entity(id: string, type: SnapEntity['type'], point: [number, number]): SnapEntity {
  return {id, type, point};
}

function project(shapes: Shape[]): Project {
  return {reference: null, layers: [layer], marks: [], shapes};
}

function circle(id: string, x: number, y: number, radius = 5): Shape {
  return {id, type: 'circle', layerId: layer.id, color: '#2e4f77', strokeWidth: 2.4,
    center: [x, y], radius};
}

describe('resolveSnap priority', () => {
  test('endpoint > midpoint > center > quadrant > intersection > grid regardless of distance', () => {
    const candidates = [
      entity('endpoint', 'endpoint', [4, 0]),
      entity('midpoint', 'midpoint', [3, 0]),
      entity('center', 'center', [2, 0]),
      entity('quadrant', 'quadrant', [1, 0]),
      entity('intersection', 'intersection', [0.5, 0])
    ];
    const raw: [number, number] = [0, 0];
    const result = resolveSnap(candidates, raw, options(1, {grid}));
    expect(result).toMatchObject({type: 'endpoint', entityId: 'endpoint', point: [4, 0]});

    expect(resolveSnap(candidates.slice(1), raw, options(1, {grid})))
      .toMatchObject({type: 'midpoint', entityId: 'midpoint'});
    expect(resolveSnap(candidates.slice(2), raw, options(1, {grid})))
      .toMatchObject({type: 'center', entityId: 'center'});
    expect(resolveSnap(candidates.slice(3), raw, options(1, {grid})))
      .toMatchObject({type: 'quadrant', entityId: 'quadrant'});
    expect(resolveSnap(candidates.slice(4), raw, options(1, {grid})))
      .toMatchObject({type: 'intersection', entityId: 'intersection'});
    expect(resolveSnap([], raw, options(1, {grid})))
      .toEqual({type: 'grid', entityId: null, point: [0, 0]});
  });

  test('same priority picks the nearest candidate', () => {
    const result = resolveSnap([
      entity('far', 'endpoint', [8, 0]),
      entity('near', 'endpoint', [2, 0])
    ], [0, 0], options());
    expect(result?.entityId).toBe('near');
    expect(result?.point).toEqual([2, 0]);
  });

  test('ties are deterministic and independent of entity order', () => {
    const a = entity('a', 'endpoint', [-5, 0]);
    const b = entity('b', 'endpoint', [5, 0]);
    expect(resolveSnap([b, a], [0, 0], options())?.entityId).toBe('a');
    expect(resolveSnap([a, b], [0, 0], options())?.entityId).toBe('a');
  });

  test('excluded entities never capture the point being dragged', () => {
    const result = resolveSnap([
      entity('moving', 'endpoint', [0, 0]),
      entity('target', 'endpoint', [6, 0])
    ], [0, 0], options(1, {exclude: new Set(['moving'])}));
    expect(result?.entityId).toBe('target');
  });
});

describe('screen-pixel threshold', () => {
  test('10px threshold stays 10 screen pixels at 10% and 800% zoom', () => {
    const at10 = (world: number): SnapEntity[] => [entity('target', 'endpoint', [world, 0])];
    // 10% zoom：1 world = 0.1px，因此 10px 阈值 = 100 world。
    expect(resolveSnap(at10(99.9), [0, 0], options(0.1))?.entityId).toBe('target');
    expect(resolveSnap(at10(100), [0, 0], options(0.1))?.entityId).toBe('target');
    expect(resolveSnap(at10(100.1), [0, 0], options(0.1))).toBeNull();

    // 800% zoom：1 world = 8px，因此 10px 阈值 = 1.25 world。
    expect(resolveSnap(at10(1.24), [0, 0], options(8))?.entityId).toBe('target');
    expect(resolveSnap(at10(1.25), [0, 0], options(8))?.entityId).toBe('target');
    expect(resolveSnap(at10(1.26), [0, 0], options(8))).toBeNull();
  });

  test('threshold conversion is linear in scale', () => {
    expect(snapThresholdWorld(options(1, {thresholdPx: 10}))).toBe(10);
    expect(snapThresholdWorld(options(2, {thresholdPx: 10}))).toBe(5);
    expect(snapThresholdWorld(options(0.1, {thresholdPx: 10}))).toBe(100);
    expect(snapThresholdWorld(options(0, {thresholdPx: 10}))).toBe(10);
  });

  test('grid only snaps when the nearest grid point is inside the pixel threshold', () => {
    expect(resolveSnap([], [12, 12], options(1, {grid: {spacing: 24, origin: [0, 0]}}))).toBeNull();
    expect(resolveSnap([], [2, 2], options(1, {grid: {spacing: 24, origin: [0, 0]}})))
      .toEqual({type: 'grid', entityId: null, point: [0, 0]});
  });

  test('a grid whose screen spacing barely exceeds the threshold never captures free drawing', () => {
    // 10% zoom 下 LOD 可能把 24 world 网格抽稀到 96 world（9.6 CSS px）：
    // 最近格点几乎必然在 10px 阈值内，若继续吸附会让所有非 Alt 绘制都被量化。
    const tiny = {spacing: 96, origin: [0, 0] as [number, number]};
    expect(resolveSnap([], [4, 4], options(0.1, {grid: tiny}))).toBeNull();
    expect(resolveSnap([], [0, 0], options(0.1, {grid: tiny}))).toBeNull();
    // 间距达到阈值两倍后恢复栅格吸附。
    expect(resolveSnap([], [0, 0], options(0.1, {grid: {spacing: 240, origin: [0, 0]}})))
      .toEqual({type: 'grid', entityId: null, point: [0, 0]});
  });
});

describe('spatial snap index', () => {
  test('prefilters candidates around the pointer instead of scanning every entity', () => {
    const shapes = Array.from({length: 2000}, (_, index) =>
      circle(`circle-${index}`, (index % 50) * 400, Math.floor(index / 50) * 400));
    const index = createSnapIndex(project(shapes));
    expect(index.size).toBeGreaterThan(8000);

    const result = index.resolve([2, 2], options());
    expect(result).toMatchObject({type: 'center', entityId: 'circle-0'});
    expect(index.lastCandidateCount).toBeGreaterThan(0);
    expect(index.lastCandidateCount).toBeLessThan(40);
    expect(index.lastCandidateCount).toBeLessThan(index.size / 100);
  });

  test('index result matches the full pure resolver', () => {
    const shapes = [
      circle('circle', 100, 100, 20),
      {id: 'rect', type: 'rect', layerId: layer.id, color: '#2e4f77', strokeWidth: 2.4,
        a: [120, 120], b: [200, 180]} as Shape
    ];
    const source = project(shapes);
    const raw: [number, number] = [120, 120];
    const expected = resolveSnap(snapEntities(source), raw, options(1, {grid}));
    const actual = createSnapIndex(source).resolve(raw, options(1, {grid}));
    expect(actual).toEqual(expected);
  });

  test('rebuild reflects committed geometry changes', () => {
    const index = createSnapIndex(project([circle('circle', 100, 100, 10)]));
    expect(index.resolve([100, 100], options())?.entityId).toBe('circle');
    index.rebuild(project([circle('circle', 300, 100, 10)]));
    expect(index.resolve([100, 100], options())).toBeNull();
    expect(index.resolve([300, 100], options())?.entityId).toBe('circle');
  });

  test('non-finite pointer/threshold is rejected and finite extremes stay bounded', () => {
    const index = createSnapIndex(project([circle('circle', 0, 0, 10)]));
    expect(index.resolve([Number.POSITIVE_INFINITY, 0], options())).toBeNull();
    expect(index.resolve([0, Number.NaN], options())).toBeNull();
    expect(index.resolve([1e308, -1e308], options())).toBeNull();
    expect(index.resolve([0, 0], {scale: 1, thresholdPx: Number.POSITIVE_INFINITY})).toBeNull();
    expect(index.resolve([0, 0], {scale: 1, thresholdPx: Number.NaN})).toBeNull();

    const candidates = [entity('circle', 'center', [0, 0])];
    expect(resolveSnap(candidates, [Number.POSITIVE_INFINITY, 0], options())).toBeNull();
    expect(resolveSnap(candidates, [0, 0],
      {scale: 1, thresholdPx: Number.POSITIVE_INFINITY})).toBeNull();
    expect(resolveSnap(candidates, [0, 0], {scale: 1, thresholdPx: 1e308}))
      .toMatchObject({type: 'center'});
    expect(Number.isNaN(snapThresholdWorld({scale: 1, thresholdPx: Number.POSITIVE_INFINITY})))
      .toBe(true);
  });
});

describe('existing Shift constraints still hold', () => {
  test('line Shift keeps 45° increments and preserves length', () => {
    const start: [number, number] = [10, 20];
    const point: [number, number] = [110, 33];
    const constrained = constrainPoint(start, point, true);
    expect(Math.hypot(constrained[0] - start[0], constrained[1] - start[1]))
      .toBeCloseTo(Math.hypot(point[0] - start[0], point[1] - start[1]), 9);
    const quarterTurns = Math.atan2(constrained[1] - start[1], constrained[0] - start[0]) * 4 / Math.PI;
    expect(Math.abs(quarterTurns - Math.round(quarterTurns))).toBeLessThan(1e-9);
    expect(constrainPoint(start, point, false)).toBe(point);
  });

  test('rect Shift stays square, including negative drag directions', () => {
    const rect = newShape('rect', {layerId: layer.id, a: [0, 0], b: [0, 0]});
    extendShape(rect, [130, -160], true);
    expect(rect.b).toEqual([160, -160]);
    extendShape(rect, [70, 30], false);
    expect(rect.b).toEqual([70, 30]);
  });

  test('line Shift produces an exact diagonal when the raw point is near 45°', () => {
    const line = newShape('line', {layerId: layer.id, points: [[0, 0], [0, 0]]});
    extendShape(line, [100, 90], true);
    expect(line.points[1][0]).toBeCloseTo(line.points[1][1], 9);
  });
});

describe('snapEntities feature extraction', () => {
  test('rect produces corners, edge midpoints and a deterministic id', () => {
    const source = project([{id: 'rect', type: 'rect', layerId: layer.id, color: '#2e4f77',
      strokeWidth: 2.4, a: [0, 0], b: [40, 20]}]);
    const entities = snapEntities(source);
    expect(entities.filter(item => item.type === 'endpoint')).toHaveLength(4);
    expect(entities.filter(item => item.type === 'midpoint')).toHaveLength(4);
    expect(entities.every(item => item.id === 'rect')).toBe(true);
    expect(resolveSnap(entities, [20, 0], options())).toMatchObject({
      type: 'midpoint', entityId: 'rect', point: [20, 0]
    });
  });

  test('circle center beats quadrant even when the quadrant is under the pointer', () => {
    const source = project([circle('circle', 0, 0, 10)]);
    const entities = snapEntities(source);
    expect(resolveSnap(entities, [10, 0], options())).toMatchObject({
      type: 'center', entityId: 'circle', point: [0, 0]
    });
  });

  test('dense multi-ring paths are sampled without spread overflow', () => {
    const ringCount = 30_000;
    const polygons = Array.from({length: ringCount}, (_, index) => [[
      [index, 0], [index + 0.5, 0], [index, 0.5]
    ] as [number, number][]]);
    const source = project([{id: 'dense', type: 'path', layerId: layer.id, color: '#2e4f77',
      strokeWidth: 2.4, polygons}]);
    const entities = snapEntities(source);
    expect(entities.length).toBeGreaterThan(0);
    expect(entities.length).toBeLessThanOrEqual(MAX_SNAP_FEATURES);
    expect(entities.length).toBeLessThan(5_000);
    const index = createSnapIndex(source);
    expect(index.size).toBe(entities.length);
  });
});
