import {describe, expect, test} from 'vitest';
import {ellipseRing} from '../geometry.ts';
import type {Project, RegionMark, TextMark} from '../project.ts';
import {textLabelCorners} from '../text-metrics.ts';
import {
  anchorCenter,
  clampViewCenter,
  clampZoom,
  exportViewBox,
  fitWorldRect,
  screenFromWorld,
  viewRectFor,
  wheelZoomFactor,
  worldFromScreen
} from '../viewport.ts';

const layer = {id: 'layer', name: '图层 1', opacity: 1};

function projectAt(x: number, y: number): Project {
  return {
    reference: null,
    layers: [layer],
    marks: [],
    shapes: [{id: 'rect', type: 'rect', layerId: layer.id, color: '#2e4f77', strokeWidth: 2.4,
      a: [x, y], b: [x + 10, y + 10]}]
  };
}

describe('viewport zoom state', () => {
  test('zoom is clamped to 10%–800%', () => {
    expect(clampZoom(0.01)).toBe(0.1);
    expect(clampZoom(99)).toBe(8);
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  test('view rect keeps the board aspect ratio and centers on the requested world point', () => {
    const view = viewRectFor([480, 300], 2, 800, 500);
    expect(view).toEqual({x: 280, y: 175, width: 400, height: 250});
    expect(view.width / view.height).toBeCloseTo(800 / 500, 12);
  });

  test('view center is clamped so the whole visible rect stays inside the model domain', () => {
    expect(clampViewCenter([2e9, -2e9], 12_800, 8_000)).toEqual([993_600, -996_000]);
    expect(clampViewCenter([1e9, -1e9], 12_800, 8_000, 1e6)).toEqual([993_600, -996_000]);
    expect(clampViewCenter([100, -100], 800, 500)).toEqual([100, -100]);
    // 视口比模型域还宽时中心归零，避免出现无意义的负数边界。
    expect(clampViewCenter([50, 50], 4e6, 3e6)).toEqual([0, 0]);
  });

  test('screen and world conversions round-trip without rounding', () => {
    const screen = {left: 100, top: 50, width: 800, height: 500};
    const view = viewRectFor([480, 300], 2, screen.width, screen.height);
    expect(worldFromScreen(500, 300, screen, view)).toEqual([480, 300]);
    expect(worldFromScreen(100, 50, screen, view)).toEqual([280, 175]);
    const world: [number, number] = [123.456, 289.987];
    const back = worldFromScreen(screenFromWorld(world, screen, view).x,
      screenFromWorld(world, screen, view).y, screen, view);
    expect(back[0]).toBeCloseTo(world[0], 9);
    expect(back[1]).toBeCloseTo(world[1], 9);
  });

  test('zoom keeps the world point under the pointer fixed', () => {
    const screen = {left: 0, top: 0, width: 800, height: 500};
    const before = viewRectFor([480, 300], 1, screen.width, screen.height);
    const anchor = worldFromScreen(200, 375, screen, before);
    const center = anchorCenter(anchor, 0.25, 0.75, 3, screen.width, screen.height);
    const after = viewRectFor(center, 3, screen.width, screen.height);
    const landed = worldFromScreen(200, 375, screen, after);
    expect(landed[0]).toBeCloseTo(anchor[0], 9);
    expect(landed[1]).toBeCloseTo(anchor[1], 9);
  });

  test('wheel delta maps to smooth zoom direction', () => {
    expect(wheelZoomFactor(-120)).toBeGreaterThan(1);
    expect(wheelZoomFactor(120)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
    // 触控板 pinch 的 delta 很小，需要更灵敏。
    expect(wheelZoomFactor(4, true)).toBeLessThan(wheelZoomFactor(4));
  });
});

describe('viewport fit and export', () => {
  test('far legal content is framed by content-only fit, even though base-union fit cannot zoom out enough', () => {
    const far = projectAt(999990, -20);
    far.shapes = [{id: 'far', type: 'rect', layerId: layer.id, color: '#2e4f77', strokeWidth: 2.4,
      a: [999990, -20], b: [1000000, 20]}];
    const content = fitWorldRect(far, 1280, 800);
    const zoom = clampZoom(1280 / content.width);
    const view = viewRectFor([content.x + content.width / 2, content.y + content.height / 2],
      zoom, 1280, 800);
    // 加载已保存草稿必须走这条路径：对象在 viewBox 内。
    expect(view.x).toBeLessThanOrEqual(999990);
    expect(view.x + view.width).toBeGreaterThanOrEqual(1000000);

    // 反例：把基准画布并进来后宽度约 1e6，zoom 被夹到 10%，对象落在 12,800 宽视口之外。
    const baseUnion = fitWorldRect(far, 1280, 800, true);
    const baseZoom = clampZoom(1280 / baseUnion.width);
    const baseView = viewRectFor([baseUnion.x + baseUnion.width / 2,
      baseUnion.y + baseUnion.height / 2], baseZoom, 1280, 800);
    expect(baseZoom).toBe(0.1);
    expect(999990).toBeGreaterThan(baseView.x + baseView.width);
  });

  test('empty project keeps the canonical 960×600 export viewBox', () => {
    const project = projectAt(480, 300);
    project.shapes = [];
    expect(fitWorldRect(project, 960, 600)).toEqual({x: 0, y: 0, width: 960, height: 600});
    expect(exportViewBox(project)).toBe('0 0 960 600');
  });

  test('fit frames only content (not the origin) and still matches the window aspect', () => {
    const wide = fitWorldRect(projectAt(2000, 300), 1600, 600);
    expect(wide.width / wide.height).toBeCloseTo(1600 / 600, 9);
    expect(wide.x).toBeLessThanOrEqual(2000);
    expect(wide.x + wide.width).toBeGreaterThanOrEqual(2010);
    // 旧实现会把原点塞进视图；新要求是内容就地适配。
    expect(wide.x).toBeGreaterThan(1000);
    expect(wide.x + wide.width / 2).toBeCloseTo(2005, 9);

    const tall = fitWorldRect(projectAt(480, 1500), 600, 900);
    expect(tall.width / tall.height).toBeCloseTo(600 / 900, 9);
    expect(tall.y).toBeLessThanOrEqual(1500);
    expect(tall.y + tall.height).toBeGreaterThanOrEqual(1510);
    expect(tall.y).toBeGreaterThan(500);
    expect(tall.y + tall.height / 2).toBeCloseTo(1505, 9);
  });

  test('export viewBox is independent of the live window aspect', () => {
    const project = projectAt(2000, 300);
    const canonical = fitWorldRect(project, 960, 600);
    expect(exportViewBox(project)).toBe(`${canonical.x} ${canonical.y} ${canonical.width} ${canonical.height}`);
    expect(canonical.width / canonical.height).toBeCloseTo(960 / 600, 9);
  });

  test('fit covers the rotated region ellipse, not just its unrotated a/b box', () => {
    const region: RegionMark = {
      id: 'region', shape: 'region', kind: 'note', label: '', value: null, unit: '',
      direction: '', question: '', confirmed: false, source: 'manual', layerId: layer.id,
      a: [390, 510], b: [840, 555], rotation: 90
    };
    const project: Project = {...projectAt(0, 0), shapes: [], marks: [region]};
    const view = fitWorldRect(project, 960, 600);
    const center: [number, number] = [615, 532.5];
    const radii: [number, number] = [225, 22.5];
    for (const [x, y] of ellipseRing(center, radii, 90)) {
      expect(x).toBeGreaterThanOrEqual(view.x);
      expect(y).toBeGreaterThanOrEqual(view.y);
      expect(x).toBeLessThanOrEqual(view.x + view.width);
      expect(y).toBeLessThanOrEqual(view.y + view.height);
    }
  });

  test('fit and export frame the rendered minimum radius of a tiny unrotated region', () => {
    const region: RegionMark = {
      id: 'tiny-region', shape: 'region', kind: 'note', label: '', value: null, unit: '',
      direction: '', question: '', confirmed: false, source: 'manual', layerId: layer.id,
      a: [500, 300], b: [501, 301]
    };
    const project: Project = {...projectAt(0, 0), shapes: [], marks: [region]};
    const view = fitWorldRect(project, 960, 600);
    const exportView = exportViewBox(project).split(' ').map(Number);
    const center: [number, number] = [500.5, 300.5];
    // 渲染半径被 REGION_MIN_RADIUS=3 抬升；F/导出必须覆盖 6×6 的可见范围。
    for (const [x, y] of [[center[0] - 3, center[1] - 3], [center[0] + 3, center[1] + 3]] as const) {
      expect(x).toBeGreaterThanOrEqual(view.x);
      expect(y).toBeGreaterThanOrEqual(view.y);
      expect(x).toBeLessThanOrEqual(view.x + view.width);
      expect(y).toBeLessThanOrEqual(view.y + view.height);
    }
    expect(exportView[0]).toBeLessThanOrEqual(center[0] - 3);
    expect(exportView[1]).toBeLessThanOrEqual(center[1] - 3);
    expect(exportView[0] + exportView[2]).toBeGreaterThanOrEqual(center[0] + 3);
    expect(exportView[1] + exportView[3]).toBeGreaterThanOrEqual(center[1] + 3);
  });

  test('fit skips non-finite points and clamps hostile finite coordinates', () => {
    const broken: Project = {
      reference: null,
      layers: [layer],
      marks: [],
      shapes: [
        {id: 'huge', type: 'rect', layerId: layer.id, color: '#2e4f77', strokeWidth: 2.4,
          a: [1e308, 1e308], b: [1e308, 1e308]},
        {id: 'nan', type: 'rect', layerId: layer.id, color: '#2e4f77', strokeWidth: 2.4,
          a: [Number.NaN, 0], b: [10, 10]}
      ]
    };
    const view = fitWorldRect(broken, 960, 600);
    expect([view.x, view.y, view.width, view.height].every(Number.isFinite)).toBe(true);
    expect(view.width).toBeLessThan(4_000_000);
    expect(exportViewBox(broken)).not.toMatch(/NaN|Infinity/);
  });

  test('fit includes the visible width of a text label instead of only its anchor', () => {
    const text: TextMark = {
      id: 'text', shape: 'text', kind: 'note', label: '载荷说明文字', value: 10, unit: 'N',
      direction: '', question: '', confirmed: false, source: 'manual', layerId: layer.id, a: [480, 300]
    };
    const project: Project = {...projectAt(0, 0), shapes: [], marks: [text]};
    const view = fitWorldRect(project, 960, 600);
    for (const [x, y] of textLabelCorners(text)) {
      expect(x).toBeGreaterThanOrEqual(view.x);
      expect(y).toBeGreaterThanOrEqual(view.y);
      expect(x).toBeLessThanOrEqual(view.x + view.width);
      expect(y).toBeLessThanOrEqual(view.y + view.height);
    }
    // 标签向右延伸超过基准画布右侧时，适配也必须把它包含进来。
    const far: TextMark = {...text, a: [930, 300]};
    const farView = fitWorldRect({...project, marks: [far]}, 960, 600);
    expect(farView.x).toBeGreaterThan(800);
    expect(farView.x + farView.width).toBeGreaterThan(930 + 100);
  });

  test('far negative content keeps finite coordinates, fit bounds and export viewBox', () => {
    const far = projectAt(-5000, -5000);
    const view = fitWorldRect(far, 960, 600);
    expect([view.x, view.y, view.width, view.height].every(Number.isFinite)).toBe(true);
    expect(view.x).toBeLessThanOrEqual(-5000);
    expect(view.y).toBeLessThanOrEqual(-5000);
    expect(view.x + view.width).toBeGreaterThanOrEqual(-4990);
    expect(view.y + view.height).toBeGreaterThanOrEqual(-4990);
    expect(view.x).toBeGreaterThan(-6000);
    expect(exportViewBox(far)).not.toMatch(/NaN|Infinity/);

    const screen = {left: 0, top: 0, width: 800, height: 500};
    const world: [number, number] = [-5000, -5000];
    const back = worldFromScreen(screenFromWorld(world, screen, view).x,
      screenFromWorld(world, screen, view).y, screen, view);
    expect(back[0]).toBeCloseTo(world[0], 9);
    expect(back[1]).toBeCloseTo(world[1], 9);
  });
});
