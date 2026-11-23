import {boardPoint} from './viewport.ts';
import {arcCircle, newShape, polygonRing, shapeKinds, sketchInk} from './geometry.ts';
import type {ArcShape, LineShape, PathShape, Point, Shape, ShapeType} from './geometry.ts';
import {markKinds, newMark} from './project.ts';
import type {Mark, MarkKind} from './project.ts';
import {normalizeBrushWidth} from './mark-width.ts';
import {normalizeArrowSize, normalizeTextFontSize} from './mark-style.ts';
import type {SnapMarker} from './renderer.ts';
import type {Brush, Tool} from './editor-types.ts';

export function readDebugSnap(): readonly SnapMarker[] {
  const value = new URLSearchParams(location.search).get('snap');
  if (!value) return [];
  const [x, y] = value.split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? [{kind: 'grid', point: [x, y]}] : [];
}

export function brushKind(value: Brush): MarkKind | null {
  return Object.hasOwn(markKinds, value) ? value as MarkKind : null;
}

export function constrainPoint(start: Point, point: Point, shift: boolean): Point {
  if (!shift) return point;
  const length = Math.hypot(point[0] - start[0], point[1] - start[1]);
  const angle = Math.round(Math.atan2(point[1] - start[1], point[0] - start[0]) / (Math.PI / 4)) * Math.PI / 4;
  return [start[0] + length * Math.cos(angle), start[1] + length * Math.sin(angle)];
}

export interface MarkStyleOptions {
  /** 新建箭头的头部长度；缺省为产品默认 21。 */
  arrowSize?: number;
  /** 新建文字的字号；缺省为产品默认 22。 */
  textFontSize?: number;
}

/** 画笔、圈选、箭头共用当前粗细；文字不写 width；箭头/文字写入独立尺寸。 */
export function createMarkForTool(tool: Tool, point: Point, brush: Brush, brushWidth: number,
  layerId: string, customColor: string, style: MarkStyleOptions = {}): Mark {
  const defaultKind: MarkKind = tool === 'arrow' ? 'force' : 'note';
  const kind = brushKind(brush) ?? defaultKind;
  const width = normalizeBrushWidth(brushWidth);
  const fields = {kind, layerId, ...(brush === 'custom' ? {color: customColor} : {})};
  if (tool === 'pen') return newMark('pen', {...fields, width, points: [point]});
  if (tool === 'region') return newMark('region', {...fields, width, a: point, b: point});
  if (tool === 'arrow') {
    return newMark('arrow', {...fields, width, size: normalizeArrowSize(style.arrowSize), a: point, b: point});
  }
  return newMark('text', {...fields, fontSize: normalizeTextFontSize(style.textFontSize), a: point});
}

function shapeStyle(brush: Brush, brushWidth: number, layerId: string,
  customColor: string): {color: string; layerId: string; strokeWidth: number} {
  const kind = brushKind(brush);
  const color = brush === 'custom' ? customColor : kind ? markKinds[kind].color : sketchInk;
  return {color, layerId, strokeWidth: normalizeBrushWidth(brushWidth)};
}

export function createShape(type: ShapeType, point: Point, brush: Brush, brushWidth: number,
  layerId: string, customColor: string): Shape {
  const style = shapeStyle(brush, brushWidth, layerId, customColor);
  switch (type) {
    case 'line':
      return newShape('line', {...style, points: [point, point]});
    case 'circle':
      return newShape('circle', {...style, center: point, radius: 0});
    case 'arc':
      return newShape('arc', {...style, points: [point, point, point]});
    case 'path':
      return newShape('path', {...style, polygons: []});
    case 'rect':
    default:
      return newShape('rect', {...style, a: point, b: point});
  }
}

/** 自由多边形复用 PathShape：单个外环 + 可选 origin，布尔/导出/命中都走同一条路径。 */
export function createPolygonShape(points: readonly Point[], brush: Brush, brushWidth: number,
  layerId: string, customColor: string): PathShape {
  const ring = polygonRing(points);
  return newShape('path', {...shapeStyle(brush, brushWidth, layerId, customColor),
    polygons: [[ring]], origin: ring[0]});
}

/** 绘制中的临时边：开放折线，不进入项目，也不生成命中代理。 */
export function polygonPreviewShape(points: readonly Point[], layerId: string): LineShape {
  return newShape('line', {layerId, color: '#3047cc', strokeWidth: 1.5,
    points: points.map(([x, y]) => [x, y] as Point)});
}

export function extendShape(shape: Shape, point: Point, shift: boolean): void {
  if (shape.type === 'line') shape.points[1] = constrainPoint(shape.points[0], point, shift);
  if (shape.type === 'rect') {
    const [ax, ay] = shape.a;
    if (!shift) shape.b = point;
    else {
      const size = Math.max(Math.abs(point[0] - ax), Math.abs(point[1] - ay));
      shape.b = [ax + Math.sign(point[0] - ax || 1) * size, ay + Math.sign(point[1] - ay || 1) * size];
    }
  }
  if (shape.type === 'circle') {
    // 800% 下 1 世界单位 = 8px，取整会让半径按 8px 台阶跳动。
    shape.radius = Math.hypot(point[0] - shape.center[0], point[1] - shape.center[1]);
  }
  if (shape.type === 'arc') {
    shape.points[2] = point;
    shape.points[1] = point;
  }
}

/**
 * 画笔采样步长固定为世界单位，持久几何不随临时 zoom 改变。
 * 0.5 在 800% 下约 4 CSS px，保证 10px 的屏幕级细笔触也不会被全部丢弃；
 * 10% 下指针事件本身已稀疏，不会因此额外增密。
 */
export const PEN_SAMPLE_STEP = 0.5;

/** 追加画笔点：只保留与上一点世界距离达到阈值的样本，阈值与视口无关。 */
export function appendPenSamples(points: Point[], samples: readonly Point[], step = PEN_SAMPLE_STEP): void {
  for (const point of samples) {
    const last = points.at(-1);
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= step) points.push(point);
  }
}

/** snap 只作用于圈选/箭头等离散标注；画笔采样必须保持原始轨迹。 */
export function extendStroke(mark: Mark, event: PointerEvent, board: SVGSVGElement,
  snap: (point: Point) => Point = point => point): void {
  if (mark.shape === 'text') return;
  const samples = event.getCoalescedEvents?.();
  const rawPoints: Point[] = [];
  for (const sample of samples?.length ? samples : [event]) rawPoints.push(boardPoint(board, sample));
  if (mark.shape === 'pen') {
    appendPenSamples(mark.points, rawPoints);
    return;
  }
  for (const raw of rawPoints) mark.b = snap(raw);
}

export function validArc(shape: ArcShape): boolean {
  return Boolean(arcCircle(shape.points));
}

export function toolShapeType(tool: Tool): ShapeType | null {
  return shapeKinds[tool as ShapeType] ? tool as ShapeType : null;
}
