import {describe, expect, test} from 'vitest';
import {markGeometry} from '../annotations.ts';
import {createMarkForTool, createShape} from '../editor-drawing.ts';
import {
  DEFAULT_BRUSH_WIDTH,
  LEGACY_MARK_WIDTH,
  LEGACY_SHAPE_WIDTH,
  MAX_MARK_WIDTH,
  MIN_MARK_WIDTH,
  clampMarkWidth,
  normalizeBrushWidth,
  normalizeShapeStrokeWidth,
  renderMarkWidth
} from '../mark-width.ts';
import {buildScene} from '../scene.ts';
import {defaultLayerId, normalizeProject} from '../project.ts';
import type {ArrowMark, PenMark, RegionMark, StoredProject, TextMark} from '../project.ts';

const base = {
  kind: 'note' as const,
  label: '',
  value: null,
  unit: '',
  direction: '',
  question: '',
  confirmed: false,
  source: 'manual' as const,
  layerId: defaultLayerId
};

const pen = (width?: number): PenMark => ({...base, id: 'pen', shape: 'pen', points: [[0, 0], [10, 0]],
  ...(width === undefined ? {} : {width})});
const region = (width?: number): RegionMark => ({...base, id: 'region', shape: 'region',
  a: [0, 0], b: [10, 10], ...(width === undefined ? {} : {width})});
const arrow = (width?: number): ArrowMark => ({...base, id: 'arrow', shape: 'arrow',
  a: [0, 0], b: [100, 10], ...(width === undefined ? {} : {width})});
const text = (): TextMark => ({...base, id: 'text', shape: 'text', a: [4, 4], label: '文字'});

const widthOf = (project: ReturnType<typeof normalizeProject>, id: string): number | undefined => {
  const mark = project.marks.find(item => item.id === id);
  return mark && mark.shape !== 'text' ? mark.width : undefined;
};

const legacyDraft = (): StoredProject => ({
  layers: [{id: defaultLayerId, name: '图层 1', opacity: 1}],
  marks: [
    {id: 'pen', shape: 'pen', points: [[0, 0], [10, 10]]},
    {id: 'region', shape: 'region', a: [0, 0], b: [10, 10]},
    {id: 'arrow', shape: 'arrow', a: [0, 0], b: [10, 10]},
    {id: 'text', shape: 'text', a: [4, 4], label: '文字'}
  ],
  shapes: []
});

describe('mark width defaults', () => {
  test('legacy marks keep the pre-feature pen/region/arrow widths', () => {
    expect(markGeometry(pen(), false).width).toBe(4);
    expect(markGeometry(region(), false).width).toBe(3);
    expect(markGeometry(arrow(), false).width).toBe(5);
    expect(DEFAULT_BRUSH_WIDTH).toBe(4);
    expect(DEFAULT_BRUSH_WIDTH).toBe(LEGACY_MARK_WIDTH.pen);
    expect(clampMarkWidth(MIN_MARK_WIDTH)).toBe(1);
    expect(clampMarkWidth(MAX_MARK_WIDTH)).toBe(24);
    expect(clampMarkWidth(0)).toBe(1);
    expect(clampMarkWidth(99)).toBe(24);
    expect(clampMarkWidth(6.6)).toBe(7);
    expect(clampMarkWidth(Number.NaN)).toBeNull();
    expect(clampMarkWidth('12')).toBeNull();
  });

  test('selection adds two pixels as a render modifier, never as stored data', () => {
    const stroke = pen(12);
    expect(renderMarkWidth(stroke, false)).toBe(12);
    expect(renderMarkWidth(stroke, true)).toBe(14);
    expect(stroke.width).toBe(12);
    expect(markGeometry(region(3), true).width).toBe(5);
    expect(markGeometry(arrow(5), true).width).toBe(7);
  });

  test('text marks stay outside the width model', () => {
    expect('width' in markGeometry(text(), false)).toBe(false);
  });
});

describe('legacy draft normalization', () => {
  test('missing widths fall back per shape without changing other marks', () => {
    const project = normalizeProject(legacyDraft());
    expect(widthOf(project, 'pen')).toBe(4);
    expect(widthOf(project, 'region')).toBe(3);
    expect(widthOf(project, 'arrow')).toBe(5);
    expect(widthOf(project, 'text')).toBeUndefined();
    expect(normalizeProject(project)).toEqual(project);
  });

  test('invalid widths clamp or fall back instead of throwing', () => {
    const project = normalizeProject({
      layers: [{id: defaultLayerId, name: '图层 1', opacity: 1}],
      marks: [
        {id: 'pen-zero', shape: 'pen', width: 0, points: [[0, 0], [1, 1]]},
        {id: 'region-huge', shape: 'region', width: 99, a: [0, 0], b: [1, 1]},
        {id: 'arrow-infinite', shape: 'arrow', width: Number.POSITIVE_INFINITY, a: [0, 0], b: [1, 1]},
        {id: 'pen-string', shape: 'pen', width: '12' as unknown as number, points: [[0, 0], [1, 1]]}
      ]
    });
    expect(widthOf(project, 'pen-zero')).toBe(1);
    expect(widthOf(project, 'region-huge')).toBe(24);
    expect(widthOf(project, 'arrow-infinite')).toBe(5);
    expect(widthOf(project, 'pen-string')).toBe(4);
  });

  test('shape stroke widths reject dirty values while keeping legacy decimals', () => {
    const project = normalizeProject({
      layers: [{id: defaultLayerId, name: '图层 1', opacity: 1}],
      marks: [],
      shapes: [
        {id: 'legacy', type: 'rect', layerId: defaultLayerId, color: '#2e4f77', strokeWidth: LEGACY_SHAPE_WIDTH,
          a: [0, 0], b: [10, 10]},
        {id: 'nan', type: 'line', layerId: defaultLayerId, color: '#2e4f77', strokeWidth: Number.NaN,
          points: [[0, 0], [10, 10]]},
        {id: 'string', type: 'circle', layerId: defaultLayerId, color: '#2e4f77',
          strokeWidth: '12' as unknown as number, center: [0, 0], radius: 4},
        {id: 'negative', type: 'arc', layerId: defaultLayerId, color: '#2e4f77', strokeWidth: -3,
          points: [[0, 0], [10, 0], [10, 10]]},
        {id: 'huge', type: 'rect', layerId: defaultLayerId, color: '#2e4f77', strokeWidth: 99,
          a: [0, 0], b: [10, 10]}
      ]
    });
    expect(project.shapes.map(shape => shape.strokeWidth)).toEqual([2.4, 2.4, 2.4, 2.4, 24]);
    expect(normalizeShapeStrokeWidth(undefined)).toBe(2.4);
    expect(normalizeProject(project)).toEqual(project);
  });

  test('render scene consumes the normalized shape width', () => {
    const project = normalizeProject({
      layers: [{id: defaultLayerId, name: '图层 1', opacity: 1}],
      marks: [],
      shapes: [{id: 'rect', type: 'rect', layerId: defaultLayerId, color: '#2e4f77',
        strokeWidth: Number.NaN, a: [0, 0], b: [10, 10]}]
    });
    const scene = buildScene(project, {viewport: {x: 0, y: 0, width: 20, height: 20,
      cssWidth: 20, cssHeight: 20, dpr: 1, pixelsPerWorldUnit: 1}});
    const strokes = scene.layers[0].primitives.filter(primitive => primitive.kind === 'stroke');
    expect(strokes.map(primitive => primitive.width)).toEqual([2.4]);
  });

  test('saved widths survive a JSON round-trip reload', () => {
    const saved = normalizeProject({
      layers: [{id: defaultLayerId, name: '图层 1', opacity: 1}],
      marks: [{id: 'pen', shape: 'pen', width: 12, points: [[0, 0], [10, 0]]}]
    });
    const stored = JSON.parse(JSON.stringify(saved)) as StoredProject;
    expect(widthOf(normalizeProject(stored), 'pen')).toBe(12);
    expect(markGeometry(normalizeProject(stored).marks[0] as PenMark, false).width).toBe(12);
  });
});

describe('current brush width applies to new content only', () => {
  const layer = defaultLayerId;

  test('changing the slider changes the next stroke width', () => {
    const thin = createMarkForTool('pen', [0, 0], 'auto', DEFAULT_BRUSH_WIDTH, layer, '#2e4f77');
    const thick = createMarkForTool('pen', [0, 0], 'auto', 12, layer, '#2e4f77');
    expect(thin.shape === 'pen' ? thin.width : null).toBe(4);
    expect(thick.shape === 'pen' ? thick.width : null).toBe(12);
    if (thick.shape !== 'pen') throw new Error('expected pen mark');
    expect(markGeometry(thick, false).width).toBe(12);
  });

  test('pen, region and arrow share the current width; text stays fixed', () => {
    for (const shape of ['pen', 'region', 'arrow'] as const) {
      const mark = createMarkForTool(shape, [0, 0], 'auto', 9, layer, '#2e4f77');
      expect(mark.shape !== 'text' ? mark.width : null).toBe(9);
      const dirty = createMarkForTool(shape, [0, 0], 'auto', Number.NaN, layer, '#2e4f77');
      expect(dirty.shape !== 'text' ? dirty.width : null).toBe(DEFAULT_BRUSH_WIDTH);
    }
    expect(createMarkForTool('text', [0, 0], 'auto', 9, layer, '#2e4f77')).not.toHaveProperty('width');
    expect(normalizeBrushWidth(undefined)).toBe(4);
    expect(normalizeBrushWidth(99)).toBe(24);
  });

  test('new geometry writes the current width into strokeWidth', () => {
    expect(createShape('line', [0, 0], 'auto', DEFAULT_BRUSH_WIDTH, layer, '#2e4f77').strokeWidth).toBe(4);
    for (const type of ['line', 'rect', 'circle', 'arc'] as const) {
      expect(createShape(type, [0, 0], 'auto', 14, layer, '#2e4f77').strokeWidth).toBe(14);
    }
    expect(createShape('line', [0, 0], 'auto', 99, layer, '#2e4f77').strokeWidth).toBe(24);
  });
});
