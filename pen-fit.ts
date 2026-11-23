import {sampleBezierPath} from './bezier.ts';
import type {BezierPath, BezierSegment} from './bezier.ts';
import type {Point} from './geometry.ts';
import type {PenMark} from './project.ts';

export type PenFitMode = 'off' | 'line' | 'curve';
export type PenCurveKind = 'quadratic' | 'cubic';

export interface PenFitOptions {
  mode: PenFitMode;
  curve: PenCurveKind;
  /** 笔宽（world 单位）；误差阈值与 RDP 容差都按它自适应。 */
  width: number;
}

export interface PenFitResult {
  path: BezierPath;
  /** 拟合后相对简化点集的最大误差（world 单位）。 */
  maxError: number;
  /** 本次使用的误差阈值，超出即保留原始手绘。 */
  threshold: number;
  simplified: Point[];
}

/** RDP 容差 = max(0.75, 笔宽 × 0.35)：去掉采样抖动，但保留真实转折。 */
const RDP_MIN_EPSILON = 0.75;
const RDP_WIDTH_FACTOR = 0.35;
/**
 * 拟合可接受误差 = max(1.5, 笔宽 × 0.9, 总长 × 0.02)。
 * 笔宽项保证细笔不因亚像素抖动被“压直”；总长项允许长弧的自然偏差。
 */
const FIT_ERROR_MIN = 1.5;
const FIT_ERROR_WIDTH_FACTOR = 0.9;
const FIT_ERROR_LENGTH_FACTOR = 0.02;
/** 短于该长度的笔迹不拟合；点按/小勾保持原始手绘。 */
const MIN_FIT_LENGTH = 6;
/** 少于该顶点数说明 RDP 已把笔迹压成直线，曲线拟合没有足够约束。 */
const MIN_CURVE_VERTICES = 3;

/**
 * @entry 手绘自动拟合：RDP 简化 → 最小二乘（首尾固定）→ 误差阈值判定。
 * 返回 null 表示应保留原始手绘，调用方不得丢弃数据。
 */
export function fitPenStroke(points: readonly Point[], options: PenFitOptions): PenFitResult | null {
  if (options.mode === 'off' || points.length < 3) return null;
  const first = points[0];
  const last = points.at(-1)!;
  const totalLength = polylineLength(points);
  if (!Number.isFinite(totalLength) || totalLength < MIN_FIT_LENGTH) return null;
  const simplified = simplifyRdp(points, Math.max(RDP_MIN_EPSILON, options.width * RDP_WIDTH_FACTOR));
  const threshold = fitErrorThreshold(options.width, totalLength);
  if (options.mode === 'line') {
    const path: BezierPath = {start: [first[0], first[1]],
      segments: [{type: 'line', end: [last[0], last[1]]}]};
    const maxError = maxDistanceToPolyline(simplified, [first, last]);
    return maxError <= threshold ? {path, maxError, threshold, simplified} : null;
  }
  if (simplified.length < MIN_CURVE_VERTICES) return null;
  const segment = fitCurve(simplified, first, last, options.curve);
  if (!segment) return null;
  const path: BezierPath = {start: [first[0], first[1]], segments: [segment]};
  const samples = sampleBezierPath(path, Math.min(0.25, threshold / 4));
  const maxError = maxDistanceToPolyline(simplified, samples);
  return maxError <= threshold ? {path, maxError, threshold, simplified} : null;
}

/**
 * 拟合结果写回 PenMark：curve 是可编辑贝塞尔，points 同步为曲线采样。
 * 未达阈值/未启用时原样返回同一个对象，调用方可据此判断是否真的发生了拟合。
 */
export function fitPenMark(mark: PenMark, options: PenFitOptions): PenMark {
  const result = fitPenStroke(mark.points, options);
  if (!result) return mark;
  return {...mark, curve: result.path, points: sampleBezierPath(result.path)};
}

/** 误差阈值供 UI/测试解释“为什么保留手绘”，与拟合内部保持单一来源。 */
export function fitErrorThreshold(width: number, totalLength: number): number {
  return Math.max(FIT_ERROR_MIN, Math.abs(width) * FIT_ERROR_WIDTH_FACTOR,
    Math.max(0, totalLength) * FIT_ERROR_LENGTH_FACTOR);
}

/**
 * Ramer–Douglas–Peucker，显式栈实现：大笔迹不会因递归深度触发栈溢出。
 * 首尾点始终保留，因为拟合要求端点固定。
 */
export function simplifyRdp(points: readonly Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points.map(point => [point[0], point[1]] as Point);
  const tolerance = Math.max(0, Number.isFinite(epsilon) ? epsilon : 0);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    if (end <= start + 1) continue;
    let farthest = -1;
    let distance = tolerance;
    for (let index = start + 1; index < end; index++) {
      const candidate = distanceToSegment(points[index], points[start], points[end]);
      if (candidate > distance) {
        distance = candidate;
        farthest = index;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([start, farthest], [farthest, end]);
  }
  const output: Point[] = [];
  for (let index = 0; index < points.length; index++) {
    if (keep[index]) output.push([points[index][0], points[index][1]]);
  }
  return output;
}

/** 弦长参数化与真实曲线参数存在偏差；两三次重投影即可让 LS 控制点收敛。 */
const FIT_REPARAMETERIZE_ITERATIONS = 3;
const PROJECTION_SAMPLES = 160;

function fitCurve(points: readonly Point[], first: Point, last: Point,
  curve: PenCurveKind): BezierSegment | null {
  let parameters = chordParameters(points);
  let segment: BezierSegment | null = null;
  for (let iteration = 0; iteration <= FIT_REPARAMETERIZE_ITERATIONS; iteration++) {
    segment = curve === 'quadratic'
      ? fitQuadratic(points, first, last, parameters)
      : fitCubic(points, first, last, parameters);
    if (!segment || iteration === FIT_REPARAMETERIZE_ITERATIONS) break;
    parameters = projectParameters(points, first, segment);
  }
  return segment;
}

/** 二次贝塞尔固定首尾，仅对单个控制点做一维最小二乘（x/y 共享标量基函数）。 */
function fitQuadratic(points: readonly Point[], first: Point, last: Point,
  parameters: readonly number[]): BezierSegment | null {
  let denominator = 0;
  const numerator: Point = [0, 0];
  points.forEach(([x, y], index) => {
    const t = parameters[index];
    const basis = 2 * (1 - t) * t;
    const residual: Point = [x - ((1 - t) ** 2 * first[0] + t ** 2 * last[0]),
      y - ((1 - t) ** 2 * first[1] + t ** 2 * last[1])];
    denominator += basis * basis;
    numerator[0] += basis * residual[0];
    numerator[1] += basis * residual[1];
  });
  if (denominator < 1e-12) return null;
  const control: Point = [numerator[0] / denominator, numerator[1] / denominator];
  return Number.isFinite(control[0]) && Number.isFinite(control[1])
    ? {type: 'quadratic', control, end: [last[0], last[1]]} : null;
}

/**
 * 三次贝塞尔固定首尾，对两个控制点解 2×2 正规方程。
 * x/y 使用同一系数矩阵，只是右端项不同。
 */
function fitCubic(points: readonly Point[], first: Point, last: Point,
  parameters: readonly number[]): BezierSegment | null {
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  const r1: Point = [0, 0];
  const r2: Point = [0, 0];
  points.forEach(([x, y], index) => {
    const t = parameters[index];
    const oneMinus = 1 - t;
    const b1 = 3 * oneMinus ** 2 * t;
    const b2 = 3 * oneMinus * t ** 2;
    a11 += b1 * b1;
    a12 += b1 * b2;
    a22 += b2 * b2;
    r1[0] += b1 * (x - (oneMinus ** 3 * first[0] + t ** 3 * last[0]));
    r1[1] += b1 * (y - (oneMinus ** 3 * first[1] + t ** 3 * last[1]));
    r2[0] += b2 * (x - (oneMinus ** 3 * first[0] + t ** 3 * last[0]));
    r2[1] += b2 * (y - (oneMinus ** 3 * first[1] + t ** 3 * last[1]));
  });
  const determinant = a11 * a22 - a12 * a12;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12 * Math.max(1, a11 * a22)) return null;
  const control1: Point = [
    (r1[0] * a22 - r2[0] * a12) / determinant,
    (r1[1] * a22 - r2[1] * a12) / determinant
  ];
  const control2: Point = [
    (r2[0] * a11 - r1[0] * a12) / determinant,
    (r2[1] * a11 - r1[1] * a12) / determinant
  ];
  return [control1[0], control1[1], control2[0], control2[1]].every(Number.isFinite)
    ? {type: 'cubic', control1, control2, end: [last[0], last[1]]}
    : null;
}

/** 以累计弦长作为初始 t；首尾权重天然为 0/1，端点固定不参与控制点求解。 */
function chordParameters(points: readonly Point[]): number[] {
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    total += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
    lengths.push(total);
  }
  const denominator = total || 1;
  return points.map((_, index) => index === 0 ? 0 :
    index === points.length - 1 ? 1 : lengths[index - 1] / denominator);
}

/** 把每个内部点投影到当前曲线最近采样，作为下一轮最小二乘的参数 t。 */
function projectParameters(points: readonly Point[], start: Point, segment: BezierSegment): number[] {
  const table: {t: number; x: number; y: number}[] = [];
  for (let index = 0; index <= PROJECTION_SAMPLES; index++) {
    const t = index / PROJECTION_SAMPLES;
    const point = segmentPoint(start, segment, t);
    table.push({t, x: point[0], y: point[1]});
  }
  return points.map((point, index) => {
    if (index === 0) return 0;
    if (index === points.length - 1) return 1;
    let best = table[0].t;
    let distance = Number.POSITIVE_INFINITY;
    for (const sample of table) {
      const candidate = (point[0] - sample.x) ** 2 + (point[1] - sample.y) ** 2;
      if (candidate < distance) {
        distance = candidate;
        best = sample.t;
      }
    }
    return best;
  });
}

function segmentPoint(start: Point, segment: BezierSegment, t: number): Point {
  if (segment.type === 'quadratic') {
    const oneMinus = 1 - t;
    return [oneMinus ** 2 * start[0] + 2 * oneMinus * t * segment.control[0] + t ** 2 * segment.end[0],
      oneMinus ** 2 * start[1] + 2 * oneMinus * t * segment.control[1] + t ** 2 * segment.end[1]];
  }
  if (segment.type === 'cubic') {
    const oneMinus = 1 - t;
    return [oneMinus ** 3 * start[0] + 3 * oneMinus ** 2 * t * segment.control1[0] +
      3 * oneMinus * t ** 2 * segment.control2[0] + t ** 3 * segment.end[0],
    oneMinus ** 3 * start[1] + 3 * oneMinus ** 2 * t * segment.control1[1] +
      3 * oneMinus * t ** 2 * segment.control2[1] + t ** 3 * segment.end[1]];
  }
  return [segment.end[0], segment.end[1]];
}

function maxDistanceToPolyline(points: readonly Point[], polyline: readonly Point[]): number {
  if (!polyline.length) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (const point of points) {
    let minimum = Number.POSITIVE_INFINITY;
    for (let index = 1; index < polyline.length; index++) {
      minimum = Math.min(minimum, distanceToSegment(point, polyline[index - 1], polyline[index]));
    }
    if (polyline.length === 1) minimum = Math.hypot(point[0] - polyline[0][0], point[1] - polyline[0][1]);
    maximum = Math.max(maximum, minimum);
  }
  return maximum;
}

function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    total += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  }
  return total;
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  const t = Math.max(0, Math.min(1,
    ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}
