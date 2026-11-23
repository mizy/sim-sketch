import {arcPoints, ellipseRing, rectCorners, sketchInk} from './geometry.ts';
import type {Point, Polygon, Shape} from './geometry.ts';
import {defaultLayerId} from './project.ts';
import type {Mark, Project} from './project.ts';
import {markGeometry} from './annotations.ts';
import {normalizeShapeStrokeWidth} from './mark-width.ts';
import {accent, paper, rgba} from './theme.ts';
import type {
  EllipsePrimitive,
  FillPrimitive,
  GridSpec,
  RenderLayer,
  RenderPrimitive,
  RenderScene,
  SnapMarker,
  StrokePrimitive
} from './renderer.ts';

export interface SceneOptions {
  viewport: RenderScene['viewport'];
  revision?: number;
  temporaryMark?: Mark | null;
  temporaryShape?: Shape | null;
  selectedMark?: string | null;
  selectedShapes?: readonly string[];
  snap?: readonly SnapMarker[];
}

export const gridSpec: GridSpec = {
  spacing: 24, radius: 1.25, origin: [1.4, 1.4],
  background: rgba(paper.background), dot: rgba(paper.dot)
};
const halo = rgba(accent, .16);
const selectedInk = rgba(accent);
/** 缩到很小时间距低于该像素时按 2 的幂抽稀网格，避免 Canvas2D 逐点绘制数十万圆点。 */
const MIN_GRID_SCREEN_SPACING = 9;

/** 交互网格 LOD 后的实际间距（world 单位）；捕捉与可见网格共用同一口径。 */
export function gridSpacingForViewport(pixelsPerWorldUnit: number): number {
  const ppu = Math.max(pixelsPerWorldUnit, 1e-6);
  let factor = 1;
  while (gridSpec.spacing * factor * ppu < MIN_GRID_SCREEN_SPACING && factor < 1024) factor *= 2;
  return gridSpec.spacing * factor;
}

/** 交互网格 LOD；导出走 drawBoard 的原生 gridSpec，不受实时缩放影响。 */
function gridForViewport(pixelsPerWorldUnit: number): GridSpec {
  const spacing = gridSpacingForViewport(pixelsPerWorldUnit);
  if (spacing === gridSpec.spacing) return gridSpec;
  return {...gridSpec, spacing, radius: gridSpec.radius * spacing / gridSpec.spacing};
}

interface RectProjection {
  a: Point;
  b: Point;
  rotation: number;
  ring: Point[];
  polygons: Polygon[];
}

/**
 * 矩形是 2000 图元场景的常态。按 shape 身份缓存 ring/polygons，
 * 让未变化图元在每帧投影后仍持有同一多边形数组，三角化缓存才能命中。
 */
const rectProjections = new WeakMap<Extract<Shape, {type: 'rect'}>, RectProjection>();

function projectRect(shape: Extract<Shape, {type: 'rect'}>): RectProjection {
  const cached = rectProjections.get(shape);
  const rotation = shape.rotation ?? 0;
  if (cached && cached.a[0] === shape.a[0] && cached.a[1] === shape.a[1] &&
    cached.b[0] === shape.b[0] && cached.b[1] === shape.b[1] &&
    cached.rotation === rotation) return cached;
  const ring = rectCorners(shape);
  const projection = {a: shape.a, b: shape.b, rotation, ring, polygons: [[ring]]};
  rectProjections.set(shape, projection);
  return projection;
}

function pushStroke(items: RenderPrimitive[], layerId: string, points: readonly Point[], color: StrokePrimitive['color'],
  width: number, closed = false, dash?: readonly [number, number]): void {
  if (points.length < 2) return;
  items.push({kind: 'stroke', layerId, points, color, width, closed, dash});
}

function pushEllipse(items: RenderPrimitive[], layerId: string, center: Point, radii: Point,
  color: EllipsePrimitive['color'], width: number, fill?: number, dash?: boolean): void {
  items.push({kind: 'ellipse', layerId, center, radii, color, width, fill, dash});
}

function pushFill(items: RenderPrimitive[], layerId: string, polygons: readonly Polygon[],
  color: FillPrimitive['color'], opacity: number): void {
  if (!polygons.length) return;
  items.push({kind: 'fill', layerId, polygons, color, opacity});
}

function addShape(items: RenderPrimitive[], shape: Shape, selected: boolean): void {
  const layerId = shape.layerId ?? defaultLayerId;
  const color = rgba(shape.color ?? sketchInk);
  const width = normalizeShapeStrokeWidth(shape.strokeWidth);
  const stroke = selected ? selectedInk : color;
  const strokeWidth = selected ? width + .8 : width;

  switch (shape.type) {
    case 'line':
      if (selected) pushStroke(items, layerId, shape.points, halo, width + 7);
      pushStroke(items, layerId, shape.points, stroke, strokeWidth);
      return;
    case 'circle': {
      const radii: Point = [Math.abs(shape.radius ?? 0), Math.abs(shape.radius ?? 0)];
      if (selected) pushEllipse(items, layerId, shape.center, radii, halo, width + 7);
      pushEllipse(items, layerId, shape.center, radii, stroke, strokeWidth, .12);
      return;
    }
    case 'arc': {
      const points = arcPoints(shape);
      if (selected) pushStroke(items, layerId, points, halo, width + 7);
      pushStroke(items, layerId, points, stroke, strokeWidth);
      return;
    }
    case 'rect': {
      const {ring, polygons} = projectRect(shape);
      if (selected) pushStroke(items, layerId, ring, halo, width + 7, true);
      pushFill(items, layerId, polygons, color, .12);
      pushStroke(items, layerId, ring, stroke, strokeWidth, true);
      return;
    }
    case 'path': {
      const polygons = shape.polygons ?? [];
      if (selected) for (const polygon of polygons) for (const ring of polygon) {
        pushStroke(items, layerId, ring, halo, width + 7, true);
      }
      pushFill(items, layerId, polygons, color, .12);
      for (const polygon of polygons) for (const ring of polygon) {
        pushStroke(items, layerId, ring, stroke, strokeWidth, true);
      }
      return;
    }
  }
}

function addMark(items: RenderPrimitive[], mark: Mark, selected: boolean): void {
  const layerId = mark.layerId ?? defaultLayerId;
  switch (mark.shape) {
    case 'pen': {
      const style = markGeometry(mark, selected);
      pushStroke(items, layerId, style.points, rgba(style.color), style.width);
      return;
    }
    case 'region': {
      const style = markGeometry(mark, selected);
      if (style.rotation) {
        // 旋转椭圆没有原生 GPU 图元；用同一采样环走 fill + stroke，三个后端结果一致。
        const ring = ellipseRing(style.center, style.radii, style.rotation);
        pushFill(items, layerId, [[ring]], rgba(style.color), style.fill);
        pushStroke(items, layerId, ring, rgba(style.color), style.width, true,
          style.dashed ? [9, 5] : undefined);
        return;
      }
      pushEllipse(items, layerId, style.center, style.radii, rgba(style.color), style.width, style.fill, style.dashed);
      return;
    }
    case 'arrow': {
      const style = markGeometry(mark, selected);
      const [a, b, left, , right] = style.points;
      pushStroke(items, layerId, [a, b], rgba(style.color), style.width);
      pushStroke(items, layerId, [left, b, right], rgba(style.color), style.width);
      return;
    }
    case 'text':
      return;
  }
}

/**
 * @entry 把 Project 投影成跨后端共享的场景。只做数据映射，不碰 DOM/GPU。
 * 文字和标签不进 scene；它们由 SVG overlay 单独消费。
 */
export function buildScene(project: Project, options: SceneOptions): RenderScene {
  const layers: RenderLayer[] = project.layers.map(layer => ({id: layer.id, opacity: layer.opacity ?? 1, primitives: []}));
  const byId = new Map(layers.map(layer => [layer.id, layer]));
  const fallback = byId.get(defaultLayerId) ?? layers[0];
  const selectedShapes = new Set(options.selectedShapes ?? []);

  for (const shape of project.shapes ?? []) {
    const target = byId.get(shape.layerId ?? defaultLayerId) ?? fallback;
    if (target) addShape(target.primitives, shape, selectedShapes.has(shape.id));
  }
  for (const mark of project.marks) {
    const target = byId.get(mark.layerId ?? defaultLayerId) ?? fallback;
    if (target) addMark(target.primitives, mark, mark.id === options.selectedMark);
  }

  const temporary: RenderPrimitive[] = [];
  if (options.temporaryShape) addShape(temporary, options.temporaryShape, false);
  if (options.temporaryMark) addMark(temporary, options.temporaryMark, false);

  return {
    revision: options.revision ?? 0,
    viewport: options.viewport,
    background: gridForViewport(options.viewport.pixelsPerWorldUnit),
    reference: project.reference ? {layerId: project.referenceLayerId ?? project.layers[0]?.id ?? defaultLayerId,
      source: project.reference} : null,
    layers,
    temporary,
    snap: options.snap ?? []
  };
}
