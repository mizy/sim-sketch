import {describe, expect, test} from 'vitest';
import {
  CLIPBOARD_FORMAT,
  CLIPBOARD_VERSION,
  clipboardContent,
  parseClipboard,
  pasteClipboard,
  serializeClipboard,
  writeClipboardText
} from '../clipboard.ts';
import {MAX_PROJECT_OBJECTS, MAX_PROJECT_VERTICES, sketchInk} from '../geometry.ts';
import type {Shape} from '../geometry.ts';
import type {Project, TextMark} from '../project.ts';

const layer = {id: 'layer-a', name: '图层 1', opacity: 1};
const target = {id: 'layer-b', name: '图层 2', opacity: 1};

function rect(id: string, x = 10, y = 20, layerId = layer.id): Shape {
  return {id, type: 'rect', layerId, color: '#2e4f77', strokeWidth: 2.4,
    a: [x, y], b: [x + 40, y + 30]};
}

function text(id: string, x = 10, y = 20): TextMark {
  return {id, shape: 'text', kind: 'note', label: '说明', value: null, unit: '',
    direction: '', question: '', confirmed: false, source: 'manual', layerId: layer.id, a: [x, y]};
}

function payload(shapes: unknown[], marks: unknown[] = []): string {
  return JSON.stringify({format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, shapes, marks});
}

function project(shapes: Shape[], marks: Project['marks'] = []): Project {
  return {reference: null, layers: [layer, target], marks, shapes};
}

describe('clipboard system write', () => {
  test('reports false when the Clipboard API is unavailable instead of silently succeeding', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true});
    try {
      await expect(writeClipboardText('x')).resolves.toBe(false);
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  test('reports true only after a real writeText succeeds', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: {writeText: async (text: string) => { writes.push(text); }},
      configurable: true
    });
    try {
      await expect(writeClipboardText('payload')).resolves.toBe(true);
      expect(writes).toEqual(['payload']);
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});

describe('clipboard payload validation', () => {
  test('rejects huge or non-finite coordinates instead of writing them into the draft', () => {
    expect(parseClipboard(payload([rect('huge', 1e308, 1e308)]))).toBeNull();
    expect(parseClipboard(payload([rect('nan', Number.NaN, 0)]))).toBeNull();
    expect(parseClipboard(payload([], [text('far', 1e308, 0)]))).toBeNull();
  });

  test('rejects payloads over object or vertex budgets', () => {
    const manyObjects = Array.from({length: MAX_PROJECT_OBJECTS + 1}, (_, index) => rect(`r-${index}`));
    expect(parseClipboard(payload(manyObjects))).toBeNull();

    const points = Array.from({length: MAX_PROJECT_VERTICES + 1}, () => [0, 0]);
    expect(parseClipboard(payload([{id: 'pen', type: 'line', layerId: layer.id,
      color: '#2e4f77', strokeWidth: 2.4, points}]))).toBeNull();
  });

  test('rejects mismatched schema versions and unrelated text', () => {
    expect(parseClipboard(JSON.stringify({format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION + 1,
      shapes: [rect('r')], marks: []}))).toBeNull();
    expect(parseClipboard('hello')).toBeNull();
    expect(parseClipboard(null)).toBeNull();
  });

  test('external colors are limited to #rrggbb and cannot inject paint servers', () => {
    const parsed = parseClipboard(payload([
      {...rect('evil'), color: 'url(#paint-server)'},
      {...rect('huge'), color: '#' + 'a'.repeat(8000)},
      {...rect('upper'), color: '#AABBCC'}
    ], [
      {...text('mark-evil'), color: 'javascript:alert(1)'},
      {...text('mark-upper'), color: '#11AA22'}
    ]));
    expect(parsed?.shapes.map(shape => shape.color)).toEqual([sketchInk, sketchInk, '#aabbcc']);
    expect(parsed?.marks[0]).not.toHaveProperty('color');
    expect(parsed?.marks[1]).toMatchObject({color: '#11aa22'});
  });

  test('expands zero-size rect/region and rejects degenerate arcs from external payloads', () => {
    const parsed = parseClipboard(payload([
      {id: 'flat', type: 'rect', layerId: layer.id, a: [10, 10], b: [10, 10]},
      {id: 'arc', type: 'arc', layerId: layer.id, points: [[0, 0], [10, 10], [20, 20]]}
    ], [
      {id: 'region', shape: 'region', layerId: layer.id, a: [20, 20], b: [20, 20]}
    ]));
    expect(parsed).not.toBeNull();
    const rect = parsed?.shapes[0];
    expect(rect?.type === 'rect' ? [rect.a, rect.b] : null).toEqual([[8, 8], [12, 12]]);
    // 共线三点没有可编辑圆心，不能进入项目后再让选择/缩放失败。
    expect(parsed?.shapes).toHaveLength(1);
    const region = parsed?.marks[0];
    expect(region?.shape === 'region' ? [region.a, region.b] : null).toEqual([[17, 17], [23, 23]]);
  });

  test('hostile external copiedAt cannot poison the local monotonic stamp', () => {
    const now = 1_700_000_000_000;
    const stamp = (copiedAt: number): string => JSON.stringify({
      format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, copiedAt,
      shapes: [rect('r')], marks: []
    });
    expect(parseClipboard(stamp(1e308), now)?.copiedAt).toBeUndefined();
    expect(parseClipboard(stamp(Number.MAX_SAFE_INTEGER), now)?.copiedAt).toBeUndefined();
    expect(parseClipboard(stamp(now + 2 * 24 * 60 * 60 * 1000), now)?.copiedAt).toBeUndefined();
    expect(parseClipboard(stamp(now - 1_000), now)?.copiedAt).toBe(now - 1_000);
  });

  test('sessionId and nonce round-trip so copiedAt can be scoped per tab', () => {
    const now = 1_700_000_000_000;
    const parsed = parseClipboard(JSON.stringify({
      format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, copiedAt: now - 1_000,
      nonce: 'nonce-a', sessionId: 'tab-a', shapes: [rect('r')], marks: []
    }), now);
    expect(parsed).toMatchObject({copiedAt: now - 1_000, nonce: 'nonce-a', sessionId: 'tab-a'});
    const external = parseClipboard(JSON.stringify({
      format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, copiedAt: now,
      sessionId: 'x'.repeat(129), shapes: [rect('r')], marks: []
    }), now);
    expect(external?.sessionId).toBeUndefined();
    expect(external?.copiedAt).toBe(now);
  });

  test('drops unknown fields and filters non-finite pen samples', () => {
    const parsed = parseClipboard(payload([], [{
      ...text('text'), unknown: 'ignored'
    }, {
      id: 'pen', shape: 'pen', kind: 'note', layerId: layer.id, width: 4,
      points: [[0, 0], [Number.NaN, 10], [20, 20]]
    }]));
    expect(parsed?.marks).toHaveLength(2);
    const pen = parsed?.marks[1];
    expect(pen?.shape).toBe('pen');
    expect(pen?.shape === 'pen' ? pen.points : []).toEqual([[0, 0], [20, 20]]);
    expect(parsed?.marks[0]).not.toHaveProperty('unknown');
  });
});

describe('paste identity, layers and translation', () => {
  test('regenerates duplicate ids and maps every object to the target layer', () => {
    const parsed = parseClipboard(payload([rect('same'), rect('same', 80)]));
    if (!parsed) throw new Error('payload should parse');
    const pasted = pasteClipboard(parsed, {dx: 16, dy: 16, targetLayerId: target.id});
    expect(pasted.shapes).toHaveLength(2);
    expect(new Set(pasted.shapes.map(shape => shape.id)).size).toBe(2);
    expect(pasted.shapes.every(shape => shape.layerId === target.id)).toBe(true);
    expect(pasted.shapes[0].type === 'rect' ? pasted.shapes[0].a : null).toEqual([26, 36]);
  });

  test('marks copied from a deleted source layer still land on the target layer', () => {
    const parsed = parseClipboard(payload([], [text('copy')]));
    if (!parsed) throw new Error('payload should parse');
    const pasted = pasteClipboard(parsed, {dx: 16, dy: 16, targetLayerId: target.id});
    expect(pasted.marks).toHaveLength(1);
    expect(pasted.marks[0].layerId).toBe(target.id);
    expect(pasted.marks[0].shape === 'text' ? pasted.marks[0].a : null).toEqual([26, 36]);
  });

  test('copying from a project sanitizes geometry and serializes a round-trippable payload', () => {
    const source = project([rect('good')], [text('note')]);
    const content = clipboardContent(source, ['good'], 'note');
    expect(content).not.toBeNull();
    const parsed = parseClipboard(serializeClipboard(content!));
    expect(parsed?.shapes[0]).toMatchObject({type: 'rect', a: [10, 20]});
    expect(parsed?.marks[0]).toMatchObject({shape: 'text'});
  });

  test('arrow size and text fontSize survive copy/paste and clamp hostile values', () => {
    const source = project([], [
      {...text('large'), fontSize: 48},
      {id: 'arrow', shape: 'arrow', kind: 'force', label: '力', value: null, unit: '',
        direction: '', question: '', confirmed: false, source: 'manual', layerId: layer.id,
        a: [0, 0], b: [200, 0], width: 5, size: 40}
    ]);
    expect(clipboardContent(source, [], null)).toBeNull();
    const arrowContent = clipboardContent(source, [], 'arrow');
    const parsed = parseClipboard(serializeClipboard(arrowContent!));
    expect(parsed?.marks[0]).toMatchObject({shape: 'arrow', size: 40, width: 5});

    const pastedText = pasteClipboard(parseClipboard(payload([], [
      {...text('copy'), fontSize: 200},
      {id: 'arrow', shape: 'arrow', layerId: layer.id, a: [0, 0], b: [200, 0], size: 200}
    ]))!, {dx: 16, dy: 16, targetLayerId: target.id});
    expect(pastedText.marks[0].shape === 'text' ? pastedText.marks[0].fontSize : undefined).toBe(96);
    expect(pastedText.marks[1].shape === 'arrow' ? pastedText.marks[1].size : undefined).toBe(96);
  });
});
