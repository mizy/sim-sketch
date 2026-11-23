import type {Point} from './geometry.ts';

/**
 * 可编辑贝塞尔路径：绝对坐标 + 逐段控制点。
 * 自由手绘拟合结果直接落到这里；`PenMark.points` 同时保存离散采样，
 * 供命中、包围盒与不支持曲线的后端回退使用。
 */
export type BezierSegment =
  | {type: 'line'; end: Point}
  | {type: 'quadratic'; control: Point; end: Point}
  | {type: 'cubic'; control1: Point; control2: Point; end: Point};

export interface BezierPath {
  start: Point;
  segments: BezierSegment[];
}

/** 单条路径的段数上限；手绘拟合只产出一段，导入/旧草稿也不能无上限扩张。 */
export const MAX_BEZIER_SEGMENTS = 64;
/** 交互绘制的离散化容差（world 单位，约等于 800% 下的 1.6px）。 */
export const CURVE_FLATTEN_TOLERANCE = 0.2;
const MAX_FLATTEN_DEPTH = 12;

/** 单条路径的原始点数；项目顶点预算与剪贴板校验共用。 */
export function bezierPointCount(path: BezierPath): number {
  return 1 + path.segments.reduce((total, segment) =>
    total + (segment.type === 'line' ? 1 : segment.type === 'quadratic' ? 2 : 3), 0);
}

/**
 * @entry 可编辑贝塞尔路径 → SVG path d。
 * 与 shapePath 共用三位小数落盘精度，避免导出与画布出现不同尾差。
 */
export function bezierPathData(path: BezierPath, precision = 3): string {
  const factor = 10 ** precision;
  const value = (number: number): number => {
    const rounded = Math.round(number * factor) / factor;
    return rounded === 0 ? 0 : rounded;
  };
  const [x, y] = path.start;
  let data = `M${value(x)} ${value(y)}`;
  for (const segment of path.segments) {
    switch (segment.type) {
      case 'line':
        data += `L${value(segment.end[0])} ${value(segment.end[1])}`;
        break;
      case 'quadratic':
        data += `Q${value(segment.control[0])} ${value(segment.control[1])}` +
          ` ${value(segment.end[0])} ${value(segment.end[1])}`;
        break;
      case 'cubic':
        data += `C${value(segment.control1[0])} ${value(segment.control1[1])}` +
          ` ${value(segment.control2[0])} ${value(segment.control2[1])}` +
          ` ${value(segment.end[0])} ${value(segment.end[1])}`;
        break;
    }
  }
  return data;
}

/** 仿射变换控制点即可保持贝塞尔语义；用于移动、缩放、旋转与剪贴板平移。 */
export function transformBezierPath(path: BezierPath, apply: (point: Point) => Point): BezierPath {
  return {
    start: apply(path.start),
    segments: path.segments.map((segment): BezierSegment => {
      switch (segment.type) {
        case 'line':
          return {type: 'line', end: apply(segment.end)};
        case 'quadratic':
          return {type: 'quadratic', control: apply(segment.control), end: apply(segment.end)};
        case 'cubic':
          return {type: 'cubic', control1: apply(segment.control1),
            control2: apply(segment.control2), end: apply(segment.end)};
      }
    })
  };
}

/**
 * @entry 自适应离散化：返回首尾精确、连续的多段线。
 * 拟合落盘时同步写入 PenMark.points，命中与所有渲染后端无需理解曲线类型。
 */
export function sampleBezierPath(path: BezierPath, tolerance = CURVE_FLATTEN_TOLERANCE): Point[] {
  const points: Point[] = [path.start];
  let current = path.start;
  for (const segment of path.segments) {
    switch (segment.type) {
      case 'line':
        pushPoint(points, segment.end);
        break;
      case 'quadratic':
        flattenCubic(points, current,
          [current[0] + (segment.control[0] - current[0]) * 2 / 3,
            current[1] + (segment.control[1] - current[1]) * 2 / 3],
          [segment.end[0] + (segment.control[0] - segment.end[0]) * 2 / 3,
            segment.end[1] + (segment.control[1] - segment.end[1]) * 2 / 3],
          segment.end, tolerance, 0);
        break;
      case 'cubic':
        flattenCubic(points, current, segment.control1, segment.control2, segment.end, tolerance, 0);
        break;
    }
    current = segment.end;
  }
  return points;
}

/**
 * 读取不可信/本地曲线的共同入口。`normalizePoint` 由调用方决定严格拒绝还是夹取。
 * 结构损坏返回 null；调用方保留原始手绘点，不丢整条笔迹。
 */
export function sanitizeBezierPath(value: unknown,
  normalizePoint: (value: unknown) => Point | null): BezierPath | null {
  if (!isRecord(value) || !Array.isArray(value.segments)) return null;
  if (!value.segments.length || value.segments.length > MAX_BEZIER_SEGMENTS) return null;
  const start = normalizePoint(value.start);
  if (!start) return null;
  const segments: BezierSegment[] = [];
  for (const raw of value.segments) {
    if (!isRecord(raw)) return null;
    const end = normalizePoint(raw.end);
    if (!end) return null;
    if (raw.type === 'line') {
      segments.push({type: 'line', end});
      continue;
    }
    if (raw.type === 'quadratic') {
      const control = normalizePoint(raw.control);
      if (!control) return null;
      segments.push({type: 'quadratic', control, end});
      continue;
    }
    if (raw.type === 'cubic') {
      const control1 = normalizePoint(raw.control1);
      const control2 = normalizePoint(raw.control2);
      if (!control1 || !control2) return null;
      segments.push({type: 'cubic', control1, control2, end});
      continue;
    }
    return null;
  }
  return {start, segments};
}

function flattenCubic(out: Point[], p0: Point, p1: Point, p2: Point, p3: Point,
  tolerance: number, depth: number): void {
  const flatness = Math.max(distanceToLine(p1, p0, p3), distanceToLine(p2, p0, p3));
  if (flatness <= tolerance || depth >= MAX_FLATTEN_DEPTH) {
    pushPoint(out, p3);
    return;
  }
  const p01 = midpoint(p0, p1);
  const p12 = midpoint(p1, p2);
  const p23 = midpoint(p2, p3);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const mid = midpoint(p012, p123);
  flattenCubic(out, p0, p01, p012, mid, tolerance, depth + 1);
  flattenCubic(out, mid, p123, p23, p3, tolerance, depth + 1);
}

function pushPoint(points: Point[], point: Point): void {
  const last = points.at(-1);
  if (last && Math.hypot(last[0] - point[0], last[1] - point[1]) < 1e-9) return;
  points.push(point);
}

function midpoint(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function distanceToLine(point: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  return Math.abs((point[0] - a[0]) * dy - (point[1] - a[1]) * dx) / length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
