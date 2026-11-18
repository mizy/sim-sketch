import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.indexedDB = {open: () => ({})};
const {defaultLayerId, normalizeProject} = await import('../project.js');

test('legacy drafts preserve marks and place the reference in its own layer', () => {
  const original = {reference: 'demo', marks: [{id: 'mark-1', shape: 'text', a: [12, 20], label: '文字'}]};
  const migrated = normalizeProject(original);
  assert.equal(migrated.reference, 'demo');
  assert.deepEqual(migrated.layers.map(layer => layer.name), ['参考图片', '图层 1']);
  assert.equal(migrated.referenceLayerId, migrated.layers[0].id);
  assert.equal(migrated.marks[0].layerId, defaultLayerId);
  assert.deepEqual(migrated.marks[0].a, [12, 20]);
  assert.equal(original.marks[0].layerId, undefined);
});

test('normalization preserves existing layer ordering, opacity and assignments', () => {
  const project = {reference: 'demo', referenceLayerId: 'picture', layers: [
    {id: 'ink', name: '标注', opacity: 0.35}, {id: 'picture', name: '图片', opacity: 0.7}
  ], marks: [{id: 'mark-1', layerId: 'ink'}]};
  assert.deepEqual(normalizeProject(project), project);
});
