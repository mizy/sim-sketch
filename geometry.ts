import {booleanPolygons, flattenCircle} from './kernel.ts';

export const sketchInk = '#2e4f77';

export type Point = [number, number];
export type Ring = Point[];
export type Polygon = Ring[];
export type ShapeType = 'line' | 'rect' | 'circle' | 'arc' | 'path';
export type BooleanOperation = 'union' | 'subtract' | 'intersect';

interface ShapeBase {
  id: string;
  type: ShapeType;
  layerId: string;
  color: string;
  strokeWidth: number;
}

export interface LineShape extends ShapeBase {
  type: 'line';
  points: Point[];
}

export interface RectShape extends ShapeBase {
  type: 'rect';
  a: Point;
  b: Point;
}

export interface CircleShape extends ShapeBase {
  type: 'circle';
  center: Point;
  radius: number;
}

export interface ArcShape extends ShapeBase {
  type: 'arc';
  points: Point[];
}

export interface PathShape extends ShapeBase {
  type: 'path';
  polygons: Polygon[];
}

export type Shape = LineShape | RectShape | CircleShape | ArcShape | PathShape;

interface ShapeGeometry {
  line: {points: Point[]};
  rect: {a: Point; b: Point};
  circle: {center: Point; radius: number};
  arc: {points: Point[]};
  path: {polygons: Polygon[]};
}

export type ShapeFields<T extends ShapeType> =
  Partial<Omit<Extract<Shape, {type: T}>, 'id' | 'type'>> & ShapeGeometry[T];

export const shapeKinds: Record<ShapeType, {label: string; closed: boolean}> = {
  line: {label: '直线', closed: false},
  rect: {label: '矩形', closed: true},
  circle: {label: '圆', closed: true},
  arc: {label: '圆弧', closed: false},
  path: {label: '布尔图形', closed: true}
};

export function newShape(type: 'line', fields: ShapeFields<'line'>): LineShape;
export function newShape(type: 'rect', fields: ShapeFields<'rect'>): RectShape;
export function newShape(type: 'circle', fields: ShapeFields<'circle'>): CircleShape;
export function newShape(type: 'arc', fields: ShapeFields<'arc'>): ArcShape;
export function newShape(type: 'path', fields: ShapeFields<'path'>): PathShape;
export function newShape(type: ShapeType, fields: ShapeFields<ShapeType>): Shape {
  return {id: crypto.randomUUID(), type, color: sketchInk, strokeWidth: 2.4, ...fields} as Shape;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

function rectCorners(shape: RectShape): Ring {
  const [x1, y1] = shape.a;
  const [x2, y2] = shape.b;
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
}

export function circlePoints(shape: CircleShape): Ring {
  const [cx, cy] = shape.center;
  const radius = Math.abs(shape.radius ?? 0);
  const segments = Math.max(32, Math.min(160, Math.ceil(2 * Math.PI * radius / 3)));
  return Array.from({length: segments}, (_, index) => {
    const angle = index / segments * Math.PI * 2;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as Point;
  });
}

export interface ArcCircle {
  center: Point;
  radius: number;
  start: number;
  end: number;
  large: boolean;
  sweep: 0 | 1;
}

export function arcCircle(points: Point[]): ArcCircle | null {
  const [[ax, ay], [bx, by], [cx, cy]] = points;
  const divisor = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(divisor) < 0.000001) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const center: Point = [
    (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / divisor,
    (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / divisor
  ];
  const radius = Math.hypot(ax - center[0], ay - center[1]);
  if (!Number.isFinite(radius) || radius < 0.5) return null;
  const angle = (point: Point): number => Math.atan2(point[1] - center[1], point[0] - center[0]);
  const turn = (value: number): number => (value % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const start = angle(points[0]);
  const through = angle(points[1]);
  const end = angle(points[2]);
  const clockwiseSweep = turn(end - start);
  const clockwiseThrough = turn(through - start);
  if (clockwiseThrough <= clockwiseSweep) {
    return {center, radius, start, end, large: clockwiseSweep > Math.PI, sweep: 1};
  }
  return {center, radius, start, end, large: turn(start - end) > Math.PI, sweep: 0};
}

export function arcPoints(shape: ArcShape): Point[] {
  const circle = arcCircle(shape.points ?? []);
  if (!circle) return (shape.points ?? []).filter((_, index) => index === 0 || index === 2);
  const {center, radius, start, end, large: _large, sweep} = circle;
  const span = sweep ? (end - start + Math.PI * 2) % (Math.PI * 2) : (start - end + Math.PI * 2) % (Math.PI * 2);
  const count = Math.max(12, Math.min(160, Math.ceil(Math.abs(span) / (Math.PI * 2) * 96)));
  return Array.from({length: count + 1}, (_, index) => {
    const offset = span * index / count * (sweep ? 1 : -1);
    return [center[0] + radius * Math.cos(start + offset), center[1] + radius * Math.sin(start + offset)] as Point;
  });
}

export function shapePath(shape: Shape): string {
  switch (shape.type) {
    case 'line': {
      const [a, b] = shape.points;
      return `M${round(a[0])} ${round(a[1])}L${round(b[0])} ${round(b[1])}`;
    }
    case 'rect': {
      const [x1, y1] = shape.a;
      const [x2, y2] = shape.b;
      return `M${round(x1)} ${round(y1)}H${round(x2)}V${round(y2)}H${round(x1)}Z`;
    }
    case 'circle': {
      const [cx, cy] = shape.center;
      const radius = Math.abs(shape.radius ?? 0);
      return `M${round(cx - radius)} ${round(cy)}A${round(radius)} ${round(radius)} 0 1 0 ${round(cx + radius)} ${round(cy)}` +
        `A${round(radius)} ${round(radius)} 0 1 0 ${round(cx - radius)} ${round(cy)}Z`;
    }
    case 'arc': {
      const [start, , end] = shape.points ?? [];
      if (!start || !end) return '';
      const circle = arcCircle(shape.points);
      if (!circle) return `M${round(start[0])} ${round(start[1])}L${round(end[0])} ${round(end[1])}`;
      return `M${round(start[0])} ${round(start[1])}A${round(circle.radius)} ${round(circle.radius)} 0 ` +
        `${circle.large ? 1 : 0} ${circle.sweep} ${round(end[0])} ${round(end[1])}`;
    }
    case 'path':
      return (shape.polygons ?? []).flat().map(ring => {
        if (!ring.length) return '';
        const [first, ...rest] = ring;
        return `M${round(first[0])} ${round(first[1])}` +
          rest.map(([x, y]) => `L${round(x)} ${round(y)}`).join('') + 'Z';
      }).join('');
    default:
      return '';
  }
}

export function shapeClosed(shape: Shape): boolean {
  return shapeKinds[shape.type]?.closed ?? false;
}

export function shapePoints(shape: Shape): Point[] {
  switch (shape.type) {
    case 'line':
    case 'arc':
      return shape.points ?? [];
    case 'rect':
      return rectCorners(shape);
    case 'circle': {
      const [cx, cy] = shape.center;
      const radius = Math.abs(shape.radius ?? 0);
      return [[cx - radius, cy - radius], [cx + radius, cy + radius]];
    }
    case 'path':
      return (shape.polygons ?? []).flat(2) as Point[];
    default:
      return [];
  }
}

export function shapeRings(shape: Shape): Polygon | Polygon[] | null {
  switch (shape.type) {
    case 'rect':
      return [rectCorners(shape)];
    case 'circle':
      return [circlePoints(shape)];
    case 'path':
      return shape.polygons ?? [];
    default:
      return null;
  }
}

export function translateShape(shape: Shape, dx: number, dy: number): Shape {
  const move = (point: Point): Point => [point[0] + dx, point[1] + dy];
  switch (shape.type) {
    case 'circle':
      return {...shape, center: move(shape.center)};
    case 'path':
      return {...shape, polygons: (shape.polygons ?? []).map(polygon => polygon.map(ring => ring.map(move)))};
    case 'rect':
      return {...shape, a: move(shape.a), b: move(shape.b)};
    case 'line':
      return {...shape, points: shape.points.map(move)};
    case 'arc':
      return {...shape, points: shape.points.map(move)};
    default:
      return shape;
  }
}

/** Each boolean operand is a MultiPolygon: a path keeps its disjoint blocks. */
export function shapePolygons(shape: Shape): Polygon[] | null {
  const rings = shapeRings(shape);
  if (!rings?.length) return null;
  if (shape.type === 'path') return rings as Polygon[];
  return [rings as Polygon];
}

/** 布尔输入规模哨兵：主线程同步布尔无法中途取消，先拒绝异常复杂的选区。 */
export function shapePointCount(shape: Shape): number {
  return shapePolygons(shape)?.reduce((polygonTotal, polygon) =>
    polygonTotal + polygon.reduce((ringTotal, ring) => ringTotal + ring.length, 0), 0) ?? 0;
}

/**
 * 布尔输入统一由 Wasm 采样圆，避免与首屏同步采样器各自漂移。
 * 非内核异常必须上抛：否则布尔崩溃会被误判成“合法空结果”。
 */
function kernelShapePolygons(shape: Shape): Polygon[] | null {
  if (shape.type === 'circle') {
    const ring = flattenCircle(shape.center, Math.abs(shape.radius ?? 0));
    return ring.length >= 3 ? [[ring]] : null;
  }
  return shapePolygons(shape);
}

export function booleanShapes(operation: BooleanOperation, shapes: Shape[]): {type: 'path'; polygons: Polygon[]} | null {
  if (shapes.length < 2) return null;
  const inputs = shapes.map(kernelShapePolygons);
  if (inputs.some(polygons => !polygons?.length)) return null;
  const result = booleanPolygons(operation, inputs as Polygon[][]);
  const polygons = result.filter(polygon => polygon.length &&
    polygon.every(ring => ring.length >= 3));
  return polygons.length ? {type: 'path', polygons} : null;
}

export function canBoolean(shapes: Shape[]): boolean {
  return shapes.length >= 2 && shapes.every(shape => shapeClosed(shape) && shapeRings(shape)?.length);
}
