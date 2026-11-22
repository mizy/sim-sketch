import {describe, expect, test} from 'vitest';
import {defaultLayerId, normalizeProject} from '../project.ts';
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
    ], marks: [{id: 'mark-1', layerId: 'ink'}], shapes: []};
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
});
