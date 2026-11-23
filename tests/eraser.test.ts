import {describe, expect, test} from 'vitest';
import {createEraseSession, eraseAlong, eraseAt, eraseSessionEmpty, erasedProject, hitTargets}
  from '../eraser.ts';
import type {PenMark, Project, RegionMark, TextMark} from '../project.ts';

const layer = {id: 'layer', name: '图层 1', opacity: 1};

const base = {
  kind: 'note' as const, label: '', value: null, unit: '', direction: '',
  question: '', confirmed: false, source: 'manual' as const, layerId: layer.id
};

const pen: PenMark = {...base, id: 'pen', shape: 'pen', width: 4,
  points: [[0, 0], [100, 0]]};
const region: RegionMark = {...base, id: 'region', shape: 'region', width: 3,
  a: [200, 0], b: [300, 100]};
const text: TextMark = {...base, id: 'text', shape: 'text', a: [400, 20], label: '载荷'};

const project: Project = {
  reference: null,
  layers: [layer],
  marks: [pen, region, text],
  shapes: [
    {id: 'line', type: 'line', layerId: layer.id, color: '#2e4f77', strokeWidth: 2, points: [[0, 200], [120, 200]]},
    {id: 'rect', type: 'rect', layerId: layer.id, color: '#2e4f77', strokeWidth: 2, a: [200, 200], b: [320, 300]}
  ]
};

describe('eraser hit testing and undo granularity', () => {
  test('hits whole strokes/annotations and shapes near the pointer', () => {
    expect(hitTargets(project, [50, 1], 2)).toMatchObject({marks: ['pen'], shapes: []});
    expect(hitTargets(project, [250, 50], 2)).toMatchObject({marks: ['region'], shapes: []});
    expect(hitTargets(project, [410, 25], 2)).toMatchObject({marks: ['text'], shapes: []});
    expect(hitTargets(project, [60, 201], 2)).toMatchObject({shapes: ['line'], marks: []});
    expect(hitTargets(project, [260, 200], 2)).toMatchObject({shapes: ['rect'], marks: []});
    // 矩形内部不按描边命中，避免拖过空白区域误删整块图形。
    expect(hitTargets(project, [260, 250], 2)).toEqual({shapes: [], marks: []});
  });

  test('one erase session removes each hit once and empty erase writes no undo', () => {
    const session = createEraseSession();
    expect(eraseAt(project, [40, 0], 4, session)).toBe(true);
    expect(eraseAt(project, [45, 0], 4, session)).toBe(false);
    expect([...session.marks]).toEqual(['pen']);
    const erased = erasedProject(project, session);
    expect(erased?.marks.map(mark => mark.id)).toEqual(['region', 'text']);
    expect(project.marks).toHaveLength(3);

    const empty = createEraseSession();
    expect(eraseAt(project, [900, 900], 4, empty)).toBe(false);
    expect(eraseSessionEmpty(empty)).toBe(true);
    // Editor 只有在 erasedProject 非 null 时 commit，因此空擦不会产生历史记录。
    expect(erasedProject(project, empty)).toBeNull();
  });

  test('dragging samples the path continuously between pointer events', () => {
    const session = createEraseSession();
    expect(eraseAlong(project, [10, 0], [250, 50], 3, session)).toBe(true);
    expect(session.marks.has('pen')).toBe(true);
    expect(session.marks.has('region')).toBe(true);
    expect(erasedProject(project, session)?.marks.map(mark => mark.id)).toEqual(['text']);
  });
});
