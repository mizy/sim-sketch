import {describe, expect, test} from 'vitest';
import {MAX_COORDINATE, MAX_PROJECT_OBJECTS, MAX_PROJECT_VERTICES} from '../geometry.ts';
import {defaultLayerId, normalizeProject, normalizeProjectWithRepair,
  projectSize, projectWithinLimits} from '../project.ts';
import type {StoredProject} from '../project.ts';

describe('project migration', () => {
  test('legacy drafts preserve marks and place the reference in its own layer', () => {
    const original: StoredProject = {reference: 'demo',
      marks: [{id: 'mark-1', shape: 'text', a: [12, 20], label: '文字'}]};
    const migrated = normalizeProject(original);
    expect(migrated.reference).toBe('demo');
    expect(migrated.layers.map(layer => layer.name)).toEqual(['参考图片', '图层 1']);
    expect(migrated.referenceLayerId).toBe(migrated.layers[0].id);
    expect(migrated.marks[0].layerId).toBe(defaultLayerId);
    expect(migrated.marks[0].shape === 'text' ? migrated.marks[0].a : null).toEqual([12, 20]);
    expect(original.marks![0].layerId).toBeUndefined();
  });

  test('legacy drafts keep items already attached to the derived reference layer', () => {
    const original: StoredProject = {reference: 'demo', layers: [
      {id: defaultLayerId, name: '图层 1', opacity: 1}
    ], marks: [{id: 'mark-1', shape: 'text', a: [1, 2], layerId: 'layer-reference'}],
    shapes: [{id: 'shape-1', type: 'line', layerId: 'layer-reference', color: '#2e4f77',
      strokeWidth: 2.4, points: [[0, 0], [4, 4]]}]};
    const migrated = normalizeProject(original);
    expect(migrated.referenceLayerId).toBe('layer-reference');
    expect(migrated.marks[0].layerId).toBe('layer-reference');
    expect(migrated.shapes[0].layerId).toBe('layer-reference');
  });

  test('an existing layer-reference layer is reused instead of duplicated', () => {
    const original: StoredProject = {reference: 'demo', layers: [
      {id: 'layer-reference', name: '参考图片', opacity: 1},
      {id: defaultLayerId, name: '图层 1', opacity: 1}
    ], shapes: [{id: 'shape-1', type: 'line', layerId: 'layer-reference', color: '#2e4f77',
      strokeWidth: 2.4, points: [[0, 0], [4, 4]]}]};
    const migrated = normalizeProject(original);
    expect(migrated.layers.filter(layer => layer.id === 'layer-reference')).toHaveLength(1);
    expect(migrated.layers).toHaveLength(2);
    expect(migrated.referenceLayerId).toBe('layer-reference');
    expect(migrated.shapes[0].layerId).toBe('layer-reference');
  });

  test('normalization preserves existing layer ordering, opacity and assignments', () => {
    const project = {reference: 'demo', referenceLayerId: 'picture', layers: [
      {id: 'ink', name: '标注', opacity: 0.35}, {id: 'picture', name: '图片', opacity: 0.7}
    ], marks: [{id: 'mark-1', shape: 'text' as const, layerId: 'ink',
      a: [0, 0] as [number, number], label: '说明'}], shapes: []};
    expect(normalizeProject(project)).toEqual(project);
  });

  test('legacy drafts gain an empty shape list and invalid shape layers fall back', () => {
    const project = {reference: null, layers: [{id: 'ink', name: '草图', opacity: 1}],
      marks: [], shapes: [{id: 'shape-1', type: 'rect' as const, layerId: 'missing',
        color: '#2e4f77', strokeWidth: 2.4, a: [0, 0] as [number, number], b: [10, 10] as [number, number]}]};
    const migrated = normalizeProject(project);
    expect(migrated.shapes[0].layerId).toBe('ink');
    expect(normalizeProject({...project, shapes: undefined}).shapes).toEqual([]);
  });

  test('finite over-bound coordinates are clamped while unrecoverable points are removed', () => {
    const goodShape = {id: 'good', type: 'rect' as const, layerId: 'ink', color: '#2e4f77',
      strokeWidth: 2.4, a: [0, 0] as [number, number], b: [10, 10] as [number, number]};
    const goodMark = {id: 'note', shape: 'text' as const, layerId: 'ink', a: [4, 5] as [number, number],
      label: '说明'};
    const project: StoredProject = {layers: [{id: 'ink', name: '草图', opacity: 1}], shapes: [
      goodShape,
      {...goodShape, id: 'huge', a: [1e308, 1e308] as [number, number]}
    ], marks: [
      goodMark,
      {...goodMark, id: 'far', a: [Number.NaN, 5] as [number, number]},
      {id: 'pen', shape: 'pen', layerId: 'ink', points: [[0, 0], [Number.NaN, 1], [20, 20]]}
    ]};
    const {project: migrated, repair} = normalizeProjectWithRepair(project);
    // 有限越界对象保留并夹取；不再因为 pan 到边界外而静默丢整份几何。
    expect(migrated.shapes).toHaveLength(2);
    expect(migrated.shapes[0]).toBe(goodShape);
    const huge = migrated.shapes[1];
    expect(huge.type === 'rect' ? huge.a : null).toEqual([MAX_COORDINATE, MAX_COORDINATE]);
    expect(migrated.marks).toHaveLength(2);
    expect(migrated.marks[0]).toBe(goodMark);
    expect(migrated.marks[1].shape === 'pen' ? migrated.marks[1].points : []).toEqual([[0, 0], [20, 20]]);
    expect(repair.clamped).toBeGreaterThan(0);
    expect(repair.dropped).toBeGreaterThan(0);
    expect(repair.droppedObjects).toBe(1);
    expect(normalizeProject(migrated)).toEqual(migrated);
  });

  test('over-bound rect and path geometry keep object identity and vertex count', () => {
    const project: StoredProject = {layers: [{id: 'ink', name: '草图', opacity: 1}], shapes: [
      {id: 'rect', type: 'rect', layerId: 'ink', color: '#2e4f77', strokeWidth: 2.4,
        a: [1000001, -1000002], b: [1000010, -1000005]},
      {id: 'path', type: 'path', layerId: 'ink', color: '#2e4f77', strokeWidth: 2.4,
        polygons: [[[[0, 0], [1000001, 0], [10, 10]]]]}
    ]};
    const {project: migrated, repair} = normalizeProjectWithRepair(project);
    expect(migrated.shapes).toHaveLength(2);
    const rect = migrated.shapes[0];
    // 越界夹取后 a/b 重合，必须再按产品下限展开，否则选择框有手柄但仿射变换返回 null。
    expect(rect.type === 'rect' ? rect : null).toMatchObject({
      a: [MAX_COORDINATE - 4, -MAX_COORDINATE], b: [MAX_COORDINATE, -MAX_COORDINATE + 4]
    });
    const path = migrated.shapes[1];
    expect(path.type === 'path' ? path.polygons[0][0] : []).toHaveLength(3);
    expect(path.type === 'path' ? path.polygons[0][0][1] : null).toEqual([MAX_COORDINATE, 0]);
    expect(repair.clamped).toBe(4);
    expect(repair.dropped).toBe(0);
  });

  test('zero-size rect/region are expanded and unknown marks are dropped on load', () => {
    const project = {
      layers: [{id: 'ink', name: '草图', opacity: 1}],
      shapes: [{id: 'flat', type: 'rect', layerId: 'ink', color: '#2e4f77', strokeWidth: 2.4,
        a: [10, 10], b: [10, 10]}],
      marks: [
        {id: 'flat-region', shape: 'region', layerId: 'ink', a: [20, 20], b: [20, 20]},
        {id: 'unknown', shape: 'bogus', layerId: 'ink', a: [0, 0]}
      ]
    } as unknown as StoredProject;
    const {project: migrated, repair} = normalizeProjectWithRepair(project);
    const rect = migrated.shapes[0];
    expect(rect.type === 'rect' ? [rect.a, rect.b] : null).toEqual([[8, 8], [12, 12]]);
    const region = migrated.marks[0];
    expect(region.shape === 'region' ? [region.a, region.b] : null).toEqual([[17, 17], [23, 23]]);
    expect(migrated.marks).toHaveLength(1);
    expect(repair.clamped).toBe(2);
    expect(repair.droppedObjects).toBe(1);
    expect(normalizeProject(migrated)).toEqual(migrated);
  });

  test('corrupted shape entries are dropped and valid objects survive normalization', () => {
    const goodShape = {id: 'good', type: 'rect' as const, layerId: 'ink', color: '#2e4f77',
      strokeWidth: 2.4, a: [0, 0] as [number, number], b: [10, 10] as [number, number]};
    const corrupted = {
      layers: [{id: 'ink', name: '草图', opacity: 1}],
      shapes: [goodShape, {id: 'bad', type: 'bogus', layerId: 'ink'}, null]
    } as unknown as StoredProject;
    const migrated = normalizeProject(corrupted);
    expect(migrated.shapes).toEqual([goodShape]);
    expect(migrated.shapes[0]).toBe(goodShape);
    // 归一化必须幂等，损坏条目不能在第二次加载时再次触发异常。
    expect(normalizeProject(migrated)).toEqual(migrated);
  });

  test('loading keeps every object; budget is reported instead of silently truncating', () => {
    const shapes = Array.from({length: MAX_PROJECT_OBJECTS + 20}, (_, index) => ({
      id: `shape-${index}`, type: 'rect' as const, layerId: 'ink', color: '#2e4f77',
      strokeWidth: 2.4, a: [index, 0] as [number, number], b: [index + 1, 1] as [number, number]
    }));
    const migrated = normalizeProject({layers: [{id: 'ink', name: '草图', opacity: 1}], shapes});
    expect(migrated.shapes).toHaveLength(MAX_PROJECT_OBJECTS + 20);
    expect(projectSize(migrated).objects).toBe(MAX_PROJECT_OBJECTS + 20);
    expect(projectWithinLimits(migrated)).toBe(false);
  });

  test('vertex budget exposes oversized legacy drafts without rewriting them', () => {
    const points = Array.from({length: MAX_PROJECT_VERTICES + 1},
      (_, index): [number, number] => [index, index]);
    const migrated = normalizeProject({layers: [{id: 'ink', name: '草图', opacity: 1}],
      marks: [{id: 'pen', shape: 'pen', layerId: 'ink', points}]});
    expect(migrated.marks).toHaveLength(1);
    expect(projectSize(migrated).vertices).toBe(MAX_PROJECT_VERTICES + 1);
    expect(projectWithinLimits(migrated)).toBe(false);
  });

  test('rect and region rotation are wrapped and invalid values are removed', () => {
    const project: StoredProject = {layers: [{id: 'ink', name: '草图', opacity: 1}], shapes: [
      {id: 'wrapped', type: 'rect', layerId: 'ink', color: '#2e4f77', strokeWidth: 2.4,
        a: [0, 0], b: [10, 10], rotation: 450},
      {id: 'invalid', type: 'rect', layerId: 'ink', color: '#2e4f77', strokeWidth: 2.4,
        a: [0, 0], b: [10, 10], rotation: Number.NaN}
    ], marks: [
      {id: 'region-wrapped', shape: 'region', layerId: 'ink', a: [0, 0], b: [20, 10], rotation: -270},
      {id: 'region-invalid', shape: 'region', layerId: 'ink', a: [0, 0], b: [20, 10],
        rotation: 'bad' as unknown as number}
    ]};
    const migrated = normalizeProject(project);
    const wrappedRect = migrated.shapes[0];
    const invalidRect = migrated.shapes[1];
    const wrappedRegion = migrated.marks[0];
    const invalidRegion = migrated.marks[1];
    expect(wrappedRect.type === 'rect' ? wrappedRect.rotation : undefined).toBe(90);
    expect(invalidRect.type === 'rect' && 'rotation' in invalidRect).toBe(false);
    expect(wrappedRegion.shape === 'region' ? wrappedRegion.rotation : undefined).toBe(90);
    expect(invalidRegion.shape === 'region' && 'rotation' in invalidRegion).toBe(false);
  });
});
