import {describe, expect, test} from 'vitest';
import {markGeometry} from '../annotations.ts';
import {createMarkForTool} from '../editor-drawing.ts';
import {arrowHeadLength, clampMarkStyleSize, DEFAULT_ARROW_SIZE, DEFAULT_TEXT_FONT_SIZE,
  normalizeArrowSize, normalizeTextFontSize} from '../mark-style.ts';
import {defaultLayerId, normalizeProject} from '../project.ts';
import type {ArrowMark, StoredProject, TextMark} from '../project.ts';
import {TEXT_LABEL_FONT_SIZE, textLabelBox, textLabelCorners} from '../text-metrics.ts';

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
const arrow = (size?: number, width = 5): ArrowMark => ({...base, id: 'arrow', shape: 'arrow',
  a: [0, 0], b: [200, 0], width, ...(size === undefined ? {} : {size})});
const text = (fontSize?: number): TextMark => ({...base, id: 'text', shape: 'text', a: [10, 20],
  label: 'AB中', ...(fontSize === undefined ? {} : {fontSize})});

describe('mark style sizes', () => {
  test('sizes are integers in 8–96 with independent defaults', () => {
    expect(clampMarkStyleSize(8)).toBe(8);
    expect(clampMarkStyleSize(96)).toBe(96);
    expect(clampMarkStyleSize(7)).toBe(8);
    expect(clampMarkStyleSize(200)).toBe(96);
    expect(clampMarkStyleSize(20.6)).toBe(21);
    expect(clampMarkStyleSize(Number.NaN)).toBeNull();
    expect(clampMarkStyleSize('40')).toBeNull();
    expect(normalizeArrowSize(undefined)).toBe(DEFAULT_ARROW_SIZE);
    expect(normalizeTextFontSize(undefined)).toBe(DEFAULT_TEXT_FONT_SIZE);
    expect(DEFAULT_ARROW_SIZE).toBe(21);
    expect(DEFAULT_TEXT_FONT_SIZE).toBe(22);
  });

  test('legacy arrow formula is unchanged when size is absent', () => {
    // 产品 AC1 的两个旧观感锚点。
    expect(arrowHeadLength(arrow(undefined, 5), 200, 5)).toBe(21);
    expect(arrowHeadLength(arrow(undefined, 24), 200, 24)).toBeCloseTo(43.2, 9);
  });

  test('explicit size wins over line width and is clamped to half the rod', () => {
    expect(arrowHeadLength(arrow(40, 24), 200, 24)).toBe(40);
    expect(arrowHeadLength(arrow(96, 5), 100, 5)).toBe(50);
    expect(arrowHeadLength(arrow(200, 5), 200, 5)).toBe(96);
    const style = markGeometry(arrow(40, 5), false);
    const [, tip, left] = style.points;
    expect(Math.hypot(tip[0] - left[0], tip[1] - left[1])).toBeCloseTo(40, 9);
  });

  test('text label box scales with fontSize from the same 22px baseline', () => {
    const legacy = textLabelBox(text());
    const large = textLabelBox(text(44));
    expect(legacy.height).toBeCloseTo(29, 9);
    expect(large.height).toBeCloseTo(58, 9);
    expect(large.width).toBeCloseTo(legacy.width * 2, 9);
    expect(large.x).toBe(4);
    expect(large.y).toBe(14);
    expect(large.font).toBe(44);
    expect(textLabelCorners(text(44))[2]).toEqual([large.x + large.width, large.y + large.height]);
  });
});

describe('mark style normalization and creation', () => {
  test('legacy fields stay absent; explicit invalid values clamp without changing semantics', () => {
    const draft: StoredProject = {
      layers: [{id: defaultLayerId, name: '图层 1', opacity: 1}],
      marks: [
        {id: 'legacy-arrow', shape: 'arrow', a: [0, 0], b: [200, 0], width: 5},
        {id: 'huge-arrow', shape: 'arrow', a: [0, 0], b: [200, 0], width: 5, size: 200},
        {id: 'bad-arrow', shape: 'arrow', a: [0, 0], b: [200, 0], width: 5,
          size: 'bad' as unknown as number},
        {id: 'legacy-text', shape: 'text', a: [10, 20], label: '旧文字'},
        {id: 'huge-text', shape: 'text', a: [10, 20], label: '大', fontSize: 200},
        {id: 'bad-text', shape: 'text', a: [10, 20], label: '坏', fontSize: Number.NaN}
      ],
      shapes: []
    };
    const project = normalizeProject(draft);
    const marks = project.marks;
    expect(marks[0].shape === 'arrow' ? marks[0].size : undefined).toBeUndefined();
    expect(marks[1].shape === 'arrow' ? marks[1].size : undefined).toBe(96);
    expect(marks[2].shape === 'arrow' ? marks[2].size : undefined).toBe(DEFAULT_ARROW_SIZE);
    expect(marks[3].shape === 'text' ? marks[3].fontSize : undefined).toBeUndefined();
    expect(marks[4].shape === 'text' ? marks[4].fontSize : undefined).toBe(96);
    expect(marks[5].shape === 'text' ? marks[5].fontSize : undefined).toBe(DEFAULT_TEXT_FONT_SIZE);
    expect(normalizeProject(project)).toEqual(project);
  });

  test('new arrows and text write the current size independently', () => {
    const arrowMark = createMarkForTool('arrow', [0, 0], 'auto', 5, defaultLayerId, '#2e4f77',
      {arrowSize: 40}) as ArrowMark;
    expect(arrowMark.size).toBe(40);
    expect(arrowMark.width).toBe(5);
    const textMark = createMarkForTool('text', [0, 0], 'auto', 5, defaultLayerId, '#2e4f77',
      {textFontSize: 48}) as TextMark;
    expect(textMark.fontSize).toBe(48);
    expect('width' in textMark).toBe(false);
    expect(markGeometry(textMark, false).fontSize).toBe(48);
    expect(TEXT_LABEL_FONT_SIZE).toBe(DEFAULT_TEXT_FONT_SIZE);
  });
});
