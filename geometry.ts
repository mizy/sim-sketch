import {booleanPolygons, flattenCircle} from './kernel.ts';
import {DEFAULT_BRUSH_WIDTH} from './mark-width.ts';

export const sketchInk = '#2e4f77';
/** 外部 payload / 损坏草稿的坐标硬上限，避免 1e308 在 fit/渲染时溢出成 Infinity。 */
export const MAX_COORDINATE = 1_000_000;
/** 单份项目与剪贴板的规模上限；正常草图远低于这两个阈值。 */
export const MAX_PROJECT_OBJECTS = 5_000;
export const MAX_PROJECT_VERTICES = 200_000;
/** 矩形/圈选退化成零宽或零高后无法再被仿射变换表达；入项目前按产品下限居中展开。 */
export const MIN_RECT_EXTENT = 4;
export const MIN_REGION_EXTENT = 6;
/** 与 transformAxialBox 的最小半轴 1e-6 对齐：全宽必须大于 2e-6 才能被缩放表达。 */
const DEGENERATE_EXTENT = 2e-6;

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
  /**
   * 绕 a/b 中心旋转的角度（度，屏幕坐标系顺时针为正）。
   * 可选字段：旧草稿没有它时保持轴对齐，读取后不写入默认值。
   */
  rotation?: number;
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
  /**
   * 自由多边形的首个顶点（world 坐标）。
   * 布尔结果没有这个字段；新增字段可选用，旧草稿读取后保持原样。
   */
  origin?: Point;
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
  path: {label: '多边形', closed: true}
};

/** 坐标合法性唯一入口：拒绝非有限值，并把合法但过大的值夹到硬上限。 */
export function boundedCoordinate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, value));
}

export function isSafePoint(value: unknown): value is Point {
  return Array.isArray(value) && value.length >= 2 &&
    boundedCoordinate(value[0]) === value[0] && boundedCoordinate(value[1]) === value[1];
}

export interface DegenerateBoxFix {
  a: Point;
  b: Point;
  /** 是否真的改了几何；调用方据此保持合法对象的引用稳定与 repair 计数。 */
  changed: boolean;
}

/**
 * @entry 零宽/零高矩形与圈选的统一修复：仅真正退化时按给定最小宽高居中展开。
 * 非退化的细小旧对象保持原样，避免迁移把用户历史几何强行放大。
 */
export function expandDegenerateBox(a: Point, b: Point, minWidth: number,
  minHeight: number): DegenerateBoxFix {
  const width = Math.abs(b[0] - a[0]);
  const height = Math.abs(b[1] - a[1]);
  const nextWidth = width > DEGENERATE_EXTENT ? width : Math.max(minWidth, DEGENERATE_EXTENT * 2);
  const nextHeight = height > DEGENERATE_EXTENT ? height : Math.max(minHeight, DEGENERATE_EXTENT * 2);
  if (nextWidth === width && nextHeight === height) return {a, b, changed: false};
  const centerX = (a[0] + b[0]) / 2;
  const centerY = (a[1] + b[1]) / 2;
  const [x1, x2] = boundedInterval(centerX, nextWidth);
  const [y1, y2] = boundedInterval(centerY, nextHeight);
  return {a: [x1, y1], b: [x2, y2], changed: true};
}

/** 展开可能越过模型硬上限；越界时整体内移，而不是把新对象写到不可绘制区域。 */
function boundedInterval(center: number, size: number): [number, number] {
  let start = center - size / 2;
  let end = start + size;
  if (start < -MAX_COORDINATE) {
    start = -MAX_COORDINATE;
    end = start + size;
  }
  if (end > MAX_COORDINATE) {
    end = MAX_COORDINATE;
    start = end - size;
  }
  return [start, end];
}

/** 本地草稿修复统计；用于在加载/提交后给用户明确提示，而不是静默改写数据。 */
export interface GeometryRepair {
  /** 有限但越界的坐标被夹到硬上限的次数。 */
  clamped: number;
  /** 非有限/结构性损坏的坐标或对象被移除的个数。 */
  dropped: number;
}

/**
 * 本地草稿的迁移入口：有限越界坐标夹到硬上限，非有限坐标丢弃。
 * 与 `isSafePoint`/`boundedCoordinate` 的严格拒绝语义分开，
 * 避免把“用户 pan 到边界外画出的合法几何”当成恶意 payload 直接删除。
 */
export function clampedPoint(value: unknown): {point: Point; clamped: boolean} | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const rawX = value[0];
  const rawY = value[1];
  if (typeof rawX !== 'number' || !Number.isFinite(rawX) ||
    typeof rawY !== 'number' || !Number.isFinite(rawY)) return null;
  const x = Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, rawX));
  const y = Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, rawY));
  return {point: [x, y], clamped: x !== rawX || y !== rawY};
}

/**
 * 本地点列迁移：保留合法点原引用，有限越界点夹取（保留顶点数与拓扑），
 * 只有非有限点才丢弃。不可信剪贴板仍走 clipboard.ts 的严格拒绝。
 * maxVertices 只用于不可信 payload；本地草稿加载传 Infinity，避免静默丢用户数据。
 */
export function sanitizedPointList(value: unknown, minimum: number,
  maxVertices = MAX_PROJECT_VERTICES, repair?: GeometryRepair): Point[] | null {
  if (!Array.isArray(value) || value.length > maxVertices) return null;
  let changed = false;
  const points: Point[] = [];
  for (const item of value) {
    const result = clampedPoint(item);
    if (!result) {
      changed = true;
      if (repair) repair.dropped++;
      continue;
    }
    if (result.clamped) {
      changed = true;
      if (repair) repair.clamped++;
    }
    points.push(result.point);
  }
  if (points.length < minimum) return null;
  return changed ? points : value as Point[];
}

/** 项目内所有图形顶点数；用于规模预算，不触发几何采样。 */
export function shapeVertexCount(shape: Shape): number {
  switch (shape.type) {
    case 'line':
    case 'arc':
      return Array.isArray(shape.points) ? shape.points.length : 0;
    case 'rect':
      return 2;
    case 'circle':
      return 1;
    case 'path': {
      let total = shape.origin ? 1 : 0;
      for (const polygon of shape.polygons ?? []) {
        for (const ring of polygon) total += ring.length;
      }
      return total;
    }
    default:
      return 0;
  }
}

/**
 * 本地草稿/交互提交的几何安全边界：保留对象与拓扑，只收敛坐标。
 * 合法对象保持原引用，保证 normalizeProject 幂等；结构性损坏对象返回 null 由调用方丢弃。
 * 外部剪贴板 payload 不走这里，仍由 clipboard.ts 严格拒绝越界数据。
 */
export function sanitizeShapeGeometry(shape: Shape, maxVertices = MAX_PROJECT_VERTICES,
  repair?: GeometryRepair): Shape | null {
  const point = (value: unknown): Point | null => {
    if (isSafePoint(value)) return value;
    const result = clampedPoint(value);
    if (!result) {
      if (repair) repair.dropped++;
      return null;
    }
    if (result.clamped && repair) repair.clamped++;
    return result.point;
  };
  switch (shape.type) {
    case 'line':
    case 'arc': {
      const points = sanitizedPointList(shape.points, shape.type === 'arc' ? 3 : 2, maxVertices, repair);
      return points ? (points === shape.points ? shape : {...shape, points}) : null;
    }
    case 'rect': {
      const a = point(shape.a);
      const b = point(shape.b);
      if (!a || !b) return null;
      const box = expandDegenerateBox(a, b, MIN_RECT_EXTENT, MIN_RECT_EXTENT);
      if (box.changed && repair) repair.clamped++;
      return a === shape.a && b === shape.b && !box.changed
        ? shape : {...shape, a: box.a, b: box.b};
    }
    case 'circle': {
      const center = point(shape.center);
      if (!center || typeof shape.radius !== 'number' || !Number.isFinite(shape.radius)) return null;
      const radius = Math.min(MAX_COORDINATE, Math.abs(shape.radius));
      if (radius !== shape.radius && repair) repair.clamped++;
      return center === shape.center && radius === shape.radius
        ? shape : {...shape, center, radius};
    }
    case 'path': {
      if (!Array.isArray(shape.polygons) || !shape.polygons.length) return null;
      let changed = false;
      let vertices = shape.origin ? 1 : 0;
      const polygons: Polygon[] = [];
      for (const polygon of shape.polygons) {
        if (!Array.isArray(polygon) || !polygon.length) return null;
        const rings: Ring[] = [];
        for (const ring of polygon) {
          const points = sanitizedPointList(ring, 3, maxVertices, repair);
          if (!points) return null;
          vertices += points.length;
          if (vertices > maxVertices) return null;
          if (points !== ring) changed = true;
          rings.push(points);
        }
        polygons.push(rings);
      }
      let origin = shape.origin;
      if (origin) {
        const bounded = point(origin);
        if (!bounded) {
          changed = true;
          origin = undefined;
        } else if (bounded !== origin) {
          changed = true;
          origin = bounded;
        }
      }
      return changed ? {...shape, polygons, ...(origin ? {origin} : {})} : shape;
    }
    default:
      // 未知/损坏的 shape.type 必须显式丢弃；返回 undefined 会让后续顶点预算抛错。
      return null;
  }
}

/** 多边形面积下限（world²）：小于它的闭合环没有可编辑意义，直接拒绝。 */
export const MIN_POLYGON_AREA = 1;
/** 顶点重合判定容差（world 单位）；屏幕上的重复点击在当前缩放下会落到同一小邻域。 */
export const POLYGON_POINT_EPSILON = 0.5;

export type PolygonIssue = 'too-few' | 'duplicate' | 'degenerate';

export function polygonArea(points: readonly Point[]): number {
  if (points.length < 3) return 0;
  let total = 0;
  for (let index = 0; index < points.length; index++) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    total += x1 * y2 - x2 * y1;
  }
  return Math.abs(total) / 2;
}

export function samePoint(a: Point, b: Point, epsilon = POLYGON_POINT_EPSILON): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= epsilon;
}

export function polygonHasPoint(points: readonly Point[], point: Point,
  epsilon = POLYGON_POINT_EPSILON): boolean {
  return points.some(existing => samePoint(existing, point, epsilon));
}

/** 闭合前校验：顶点数、重合点、近零面积。返回 null 表示可以落盘。 */
export function polygonIssue(points: readonly Point[], minArea = MIN_POLYGON_AREA): PolygonIssue | null {
  if (points.length < 3) return 'too-few';
  for (let index = 0; index < points.length; index++) {
    for (let other = index + 1; other < points.length; other++) {
      if (samePoint(points[index], points[other])) return 'duplicate';
    }
  }
  return polygonArea(points) < minArea ? 'degenerate' : null;
}

export function polygonIssueText(issue: PolygonIssue): string {
  switch (issue) {
    case 'too-few':
      return '多边形至少需要 3 个顶点。';
    case 'duplicate':
      return '多边形不能包含重合顶点，请换一个位置。';
    case 'degenerate':
      return '多边形面积接近零，请重新绘制。';
  }
}

/** 落盘前统一三位小数，和 shapePath 的输出精度保持一致。 */
export function polygonRing(points: readonly Point[]): Ring {
  return points.map(([x, y]) => [round(x), round(y)] as Point);
}

export function newShape(type: 'line', fields: ShapeFields<'line'>): LineShape;
export function newShape(type: 'rect', fields: ShapeFields<'rect'>): RectShape;
export function newShape(type: 'circle', fields: ShapeFields<'circle'>): CircleShape;
export function newShape(type: 'arc', fields: ShapeFields<'arc'>): ArcShape;
export function newShape(type: 'path', fields: ShapeFields<'path'>): PathShape;
export function newShape(type: ShapeType, fields: ShapeFields<ShapeType>): Shape {
  return {id: crypto.randomUUID(), type, color: sketchInk, strokeWidth: DEFAULT_BRUSH_WIDTH, ...fields} as Shape;
}

const round = (value: number): number => {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
};

/** 收敛到 (-180, 180]；非法值返回 null，由数据规范化决定是否移除字段。 */
export function normalizeRotation(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const wrapped = ((value % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

export function rotatePoint(point: Point, pivot: Point, radians: number): Point {
  if (!radians) return [point[0], point[1]];
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point[0] - pivot[0];
  const dy = point[1] - pivot[1];
  return [pivot[0] + dx * cos - dy * sin, pivot[1] + dx * sin + dy * cos];
}

/**
 * @entry 矩形四角。rotation 只改变显示/布尔/命中使用的角点，
 * a/b 仍是未旋转的局部包围盒，因此旧草稿和属性面板语义不变。
 */
export function rectCorners(shape: RectShape): Ring {
  const [x1, y1] = shape.a;
  const [x2, y2] = shape.b;
  const corners: Ring = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  const rotation = normalizeRotation(shape.rotation);
  if (!rotation) return corners;
  const pivot: Point = [(x1 + x2) / 2, (y1 + y2) / 2];
  return corners.map(point => rotatePoint(point, pivot, rotation * Math.PI / 180));
}

/** 旋转椭圆的采样环；圈选区域旋转后用同一路径渲染、命中和导出。 */
export function ellipseRing(center: Point, radii: Point, rotationDegrees = 0, segments = 64): Ring {
  const radians = rotationDegrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const count = Math.max(16, Math.min(160, Math.round(segments)));
  return Array.from({length: count}, (_, index) => {
    const angle = index / count * Math.PI * 2;
    const x = radii[0] * Math.cos(angle);
    const y = radii[1] * Math.sin(angle);
    return [center[0] + x * cos - y * sin, center[1] + x * sin + y * cos] as Point;
  });
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
      const points = shape.points ?? [];
      if (!points.length) return '';
      const [first, ...rest] = points;
      return `M${round(first[0])} ${round(first[1])}` +
        rest.map(([x, y]) => `L${round(x)} ${round(y)}`).join('');
    }
    case 'rect': {
      const rotation = normalizeRotation(shape.rotation);
      if (rotation) {
        const [first, ...rest] = rectCorners(shape);
        return `M${round(first[0])} ${round(first[1])}` +
          rest.map(([x, y]) => `L${round(x)} ${round(y)}`).join('') + 'Z';
      }
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
      return {...shape, ...(shape.origin ? {origin: move(shape.origin)} : {}),
        polygons: (shape.polygons ?? []).map(polygon => polygon.map(ring => ring.map(move)))};
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
