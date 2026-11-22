import {boardPoint} from './board.ts';
import {arcCircle, newShape, shapeKinds, sketchInk} from './geometry.ts';
import type {ArcShape, Point, Shape, ShapeType} from './geometry.ts';
import {markKinds, newMark} from './project.ts';
import type {Mark, MarkKind} from './project.ts';
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

export function translatedMark(mark: Mark, dx: number, dy: number): Mark {
  const move = (point: Point): Point => [point[0] + dx, point[1] + dy];
  switch (mark.shape) {
    case 'pen':
      return {...mark, points: mark.points.map(move)};
    case 'region':
    case 'arrow':
      return {...mark, a: move(mark.a), b: move(mark.b)};
    case 'text':
      return {...mark, a: move(mark.a)};
  }
}

export function constrainPoint(start: Point, point: Point, shift: boolean): Point {
  if (!shift) return point;
  const length = Math.hypot(point[0] - start[0], point[1] - start[1]);
  const angle = Math.round(Math.atan2(point[1] - start[1], point[0] - start[0]) / (Math.PI / 4)) * Math.PI / 4;
  return [Math.round(start[0] + length * Math.cos(angle)), Math.round(start[1] + length * Math.sin(angle))];
}

export function createMarkForTool(tool: Tool, point: Point, brush: Brush,
  layerId: string, customColor: string): Mark {
  const defaultKind: MarkKind = tool === 'arrow' ? 'force' : 'note';
  const kind = brushKind(brush) ?? defaultKind;
  const fields = {kind, layerId, ...(brush === 'custom' ? {color: customColor} : {})};
  if (tool === 'pen') return newMark('pen', {...fields, points: [point]});
  if (tool === 'region') return newMark('region', {...fields, a: point, b: point});
  if (tool === 'arrow') return newMark('arrow', {...fields, a: point, b: point});
  return newMark('text', {...fields, a: point});
}

export function createShape(type: ShapeType, point: Point, brush: Brush, layerId: string,
  customColor: string): Shape {
  const kind = brushKind(brush);
  const color = brush === 'custom' ? customColor : kind ? markKinds[kind].color : sketchInk;
  const style = {color, layerId};
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

export function extendShape(shape: Shape, event: PointerEvent, board: SVGSVGElement): void {
  const point = boardPoint(board, event);
  if (shape.type === 'line') shape.points[1] = constrainPoint(shape.points[0], point, event.shiftKey);
  if (shape.type === 'rect') {
    const [ax, ay] = shape.a;
    if (!event.shiftKey) shape.b = point;
    else {
      const size = Math.max(Math.abs(point[0] - ax), Math.abs(point[1] - ay));
      shape.b = [ax + Math.sign(point[0] - ax || 1) * size, ay + Math.sign(point[1] - ay || 1) * size];
    }
  }
  if (shape.type === 'circle') {
    shape.radius = Math.round(Math.hypot(point[0] - shape.center[0], point[1] - shape.center[1]));
  }
  if (shape.type === 'arc') {
    shape.points[2] = point;
    shape.points[1] = point;
  }
}

export function extendStroke(mark: Mark, event: PointerEvent, board: SVGSVGElement): void {
  if (mark.shape === 'text') return;
  const samples = event.getCoalescedEvents?.();
  for (const sample of samples?.length ? samples : [event]) {
    const point = boardPoint(board, sample);
    if (mark.shape !== 'pen') mark.b = point;
    else {
      const last = mark.points.at(-1)!;
      if (Math.hypot(last[0] - point[0], last[1] - point[1]) >= 2) mark.points.push(point);
    }
  }
}

export function validArc(shape: ArcShape): boolean {
  return Boolean(arcCircle(shape.points));
}

export function toolShapeType(tool: Tool): ShapeType | null {
  return shapeKinds[tool as ShapeType] ? tool as ShapeType : null;
}
