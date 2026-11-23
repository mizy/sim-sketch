import {markGeometry, REGION_MIN_RADIUS} from './annotations.ts';
import {transformBezierPath} from './bezier.ts';
import {arcPoints, ellipseRing, normalizeRotation, rectCorners} from './geometry.ts';
import type {Point, Shape} from './geometry.ts';
import type {Mark, RegionMark} from './project.ts';
import {textLabelCorners} from './text-metrics.ts';

/** 2D 仿射矩阵；与 SVG matrix(a b c d e f) 同序。 */
export interface AffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface WorldBounds {
  min: Point;
  max: Point;
}

export type TransformHandle =
  | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
  | 'rotate';
export type ScaleHandle = Exclude<TransformHandle, 'rotate'>;

export interface Selection {
  shapes: readonly Shape[];
  marks: readonly Mark[];
}

/**
 * 变换框：中心 + 自身旋转角 + 局部半宽/半高。
 * 矩形与旋转圈选沿自身轴缩放时仍保留原类型；文本 mode=none 只允许移动。
 */
export interface TransformFrame {
  center: Point;
  /** 弧度，屏幕坐标系（y 向下）顺时针为正。 */
  rotation: number;
  /** 对象真实半宽/半高；缩放 pivot、比例与最小尺寸只读这里。 */
  half: Point;
  /** 手柄可视/可抓取半径：仅用来把极小对象的外框扩到 14 world，不参与几何计算。 */
  handleHalf: Point;
  mode: 'free' | 'uniform' | 'none';
  rotatable: boolean;
  /** 缩放夹取用的最小世界宽高；线段退化的轴保持 0。 */
  minExtent: Point;
}

export const SCALE_HANDLES: readonly ScaleHandle[] =
  ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CORNER_HANDLES: readonly ScaleHandle[] = ['nw', 'ne', 'se', 'sw'];
const MIN_SCALE = 0.01;
const MATRIX_EPSILON = 1e-9;
const DEGREES = 180 / Math.PI;

/** 以 pivot 为不动的点做轴向缩放。 */
export function scaleMatrix(pivot: Point, sx: number, sy: number): AffineMatrix {
  return {a: sx, b: 0, c: 0, d: sy, e: pivot[0] * (1 - sx), f: pivot[1] * (1 - sy)};
}

/** 以 pivot 为中心旋转；正角度在屏幕坐标系（y 向下）中表现为顺时针。 */
export function rotationMatrix(pivot: Point, radians: number): AffineMatrix {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    a: cos, b: sin, c: -sin, d: cos,
    e: pivot[0] - cos * pivot[0] + sin * pivot[1],
    f: pivot[1] - sin * pivot[0] - cos * pivot[1]
  };
}

export function applyMatrix(point: Point, matrix: AffineMatrix): Point {
  return [
    matrix.a * point[0] + matrix.c * point[1] + matrix.e,
    matrix.b * point[0] + matrix.d * point[1] + matrix.f
  ];
}

/** 先应用 second，再应用 first；用于把局部缩放夹在“世界→局部→世界”之间。 */
export function multiplyMatrix(first: AffineMatrix, second: AffineMatrix): AffineMatrix {
  return {
    a: first.a * second.a + first.c * second.b,
    b: first.b * second.a + first.d * second.b,
    c: first.a * second.c + first.c * second.d,
    d: first.b * second.c + first.d * second.d,
    e: first.a * second.e + first.c * second.f + first.e,
    f: first.b * second.e + first.d * second.f + first.f
  };
}

export function translationMatrix(x: number, y: number): AffineMatrix {
  return {a: 1, b: 0, c: 0, d: 1, e: x, f: y};
}

/** 均匀缩放系数；只对相似矩阵有意义。 */
export function matrixScale(matrix: AffineMatrix): number {
  return Math.hypot(matrix.a, matrix.b);
}

/** 只含等比缩放 + 旋转 + 平移，不产生拉伸/切变。 */
export function isSimilarityMatrix(matrix: AffineMatrix): boolean {
  const magnitude = Math.max(1, Math.abs(matrix.a), Math.abs(matrix.b), Math.abs(matrix.c), Math.abs(matrix.d));
  const tolerance = MATRIX_EPSILON * magnitude;
  return matrix.a * matrix.d - matrix.b * matrix.c > 0 &&
    Math.abs(matrix.a - matrix.d) <= tolerance &&
    Math.abs(matrix.b + matrix.c) <= tolerance;
}

/** 旧数据没有 rotation 且结果仍为 0 时不新增字段，保持草稿增量最小。 */
function rotationField(previous: number | undefined, next: number): {rotation?: number} {
  return next === 0 && previous === undefined ? {} : {rotation: next};
}

/**
 * @entry 图形仿射变换。矩形沿自身局部轴缩放（selectionFrame + frameScaleMatrix）
 * 时保留 type=rect 与 rotation；只有会产生切变、无法再用旋转矩形表达时返回 null，
 * 绝不静默改写成 path。圆/圆弧同样拒绝非等比变换，由交互层强制等比。
 */
export function transformShape(shape: Shape, matrix: AffineMatrix): Shape | null {
  switch (shape.type) {
    case 'line':
      return {...shape, points: shape.points.map(point => applyMatrix(point, matrix))};
    case 'rect':
      return transformRect(shape, matrix);
    case 'circle': {
      if (!isSimilarityMatrix(matrix)) return null;
      const scale = matrixScale(matrix);
      return {...shape, center: applyMatrix(shape.center, matrix), radius: Math.abs(shape.radius) * scale};
    }
    case 'arc': {
      if (!isSimilarityMatrix(matrix)) return null;
      return {...shape, points: shape.points.map(point => applyMatrix(point, matrix))};
    }
    case 'path':
      return {...shape,
        ...(shape.origin ? {origin: applyMatrix(shape.origin, matrix)} : {}),
        polygons: shape.polygons.map(polygon => polygon.map(ring =>
          ring.map(point => applyMatrix(point, matrix))))};
    default:
      return null;
  }
}

interface AxialBox {
  a: Point;
  b: Point;
  rotation?: number;
}

/**
 * 旋转矩形/圈选只有“局部轴缩放”仍能被 a/b + rotation 无损表达。
 * 先检查变换后的两条局部轴是否仍正交；切变（例如世界轴非等比缩放旋转矩形）
 * 返回 null，交由交互层提示用户逐个沿自身轴缩放。
 */
function transformAxialBox<T extends AxialBox>(box: T, matrix: AffineMatrix): T | null {
  const radians = (box.rotation ?? 0) / DEGREES;
  const center: Point = [(box.a[0] + box.b[0]) / 2, (box.a[1] + box.b[1]) / 2];
  const halfX = Math.abs(box.b[0] - box.a[0]) / 2;
  const halfY = Math.abs(box.b[1] - box.a[1]) / 2;
  const axisX: Point = [halfX * Math.cos(radians), halfX * Math.sin(radians)];
  const axisY: Point = [-halfY * Math.sin(radians), halfY * Math.cos(radians)];
  const nextCenter = applyMatrix(center, matrix);
  const nextX = linearPoint(axisX, matrix);
  const nextY = linearPoint(axisY, matrix);
  if (!perpendicular(nextX, nextY)) return null;
  const nextRotation = normalizeRotation(Math.atan2(nextX[1], nextX[0]) * DEGREES) ?? 0;
  const nextHalfX = Math.hypot(nextX[0], nextX[1]);
  const nextHalfY = Math.hypot(nextY[0], nextY[1]);
  if (!Number.isFinite(nextHalfX) || !Number.isFinite(nextHalfY) ||
    nextHalfX < 1e-6 || nextHalfY < 1e-6) return null;
  return {
    ...box,
    a: [nextCenter[0] - nextHalfX, nextCenter[1] - nextHalfY],
    b: [nextCenter[0] + nextHalfX, nextCenter[1] + nextHalfY],
    ...rotationField(box.rotation, nextRotation)
  };
}

function transformRect(shape: Extract<Shape, {type: 'rect'}>, matrix: AffineMatrix): Shape | null {
  return transformAxialBox(shape, matrix);
}

function linearPoint(point: Point, matrix: AffineMatrix): Point {
  return [
    matrix.a * point[0] + matrix.c * point[1],
    matrix.b * point[0] + matrix.d * point[1]
  ];
}

function perpendicular(first: Point, second: Point): boolean {
  const dot = first[0] * second[0] + first[1] * second[1];
  const scale = Math.hypot(first[0], first[1]) * Math.hypot(second[0], second[1]);
  return scale < 1e-12 || Math.abs(dot) <= 1e-7 * scale;
}

/**
 * @entry 标注仿射变换。画笔/箭头走点集，文字只移动锚点以保持可读可编辑。
 * 圈选区域用可选 rotation 表示旋转椭圆；旋转后再做非等比轴向缩放返回 null。
 */
export function transformMark(mark: Mark, matrix: AffineMatrix): Mark | null {
  switch (mark.shape) {
    case 'pen':
      return {...mark,
        points: mark.points.map(point => applyMatrix(point, matrix)),
        ...(mark.curve ? {curve: transformBezierPath(mark.curve, point => applyMatrix(point, matrix))} : {})};
    case 'region':
      return transformRegion(mark, matrix);
    case 'arrow':
      return {...mark, a: applyMatrix(mark.a, matrix), b: applyMatrix(mark.b, matrix)};
    case 'text':
      return {...mark, a: applyMatrix(mark.a, matrix)};
    default:
      return null;
  }
}

function transformRegion(mark: RegionMark, matrix: AffineMatrix): RegionMark | null {
  const next = transformAxialBox(mark, matrix);
  if (!next) return null;
  // 落盘几何也遵守可见半径下限；否则连续缩放会一直显示 6 world 宽而选择框在内部。
  const center: Point = [(next.a[0] + next.b[0]) / 2, (next.a[1] + next.b[1]) / 2];
  const halfX = Math.max(REGION_MIN_RADIUS, Math.abs(next.b[0] - next.a[0]) / 2);
  const halfY = Math.max(REGION_MIN_RADIUS, Math.abs(next.b[1] - next.a[1]) / 2);
  return {...next, a: [center[0] - halfX, center[1] - halfY], b: [center[0] + halfX, center[1] + halfY]};
}

/**
 * @entry 选中对象的世界包围盒。零宽/零高对象按 minSize 扩成可抓取区域，
 * 避免水平直线、单点文字的手柄重叠在一起。
 */
export function selectionBounds(selection: Selection, minSize = 0): WorldBounds | null {
  // 流式累计 min/max：大型路径不再先收集点、再 filter 出第二份数组。
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const visit = ([x, y]: Point): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  // 逐点访问：20 万顶点路径/画笔用 spread 会触发 V8 的 push(...大数组) 栈溢出。
  for (const shape of selection.shapes) {
    for (const point of shapeBoundPoints(shape)) visit(point);
  }
  for (const mark of selection.marks) {
    for (const point of markBoundPoints(mark)) visit(point);
  }
  return boundsFromExtents(minX, minY, maxX, maxY, minSize);
}

export function boundsFromPoints(points: readonly Point[], minSize = 0): WorldBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return boundsFromExtents(minX, minY, maxX, maxY, minSize);
}

function boundsFromExtents(minX: number, minY: number, maxX: number, maxY: number,
  minSize = 0): WorldBounds | null {
  if (!Number.isFinite(minX) || !Number.isFinite(minY) ||
    !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const half = Math.max(minSize, 0) / 2;
  return {
    min: [Math.min(minX, centerX - half), Math.min(minY, centerY - half)],
    max: [Math.max(maxX, centerX + half), Math.max(maxY, centerY + half)]
  };
}

export function boundsCenter(bounds: WorldBounds): Point {
  return [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2];
}

/**
 * @entry 选择框。单选旋转矩形/旋转圈选取自身轴；圆与圆弧只给四角等比手柄；
 * 文本 mode=none，只允许移动，不生成任何缩放/旋转手柄。
 */
export function selectionFrame(selection: Selection, minSize = 0): TransformFrame | null {
  const singleShape = selection.shapes.length === 1 && selection.marks.length === 0
    ? selection.shapes[0] : null;
  const singleMark = selection.marks.length === 1 && selection.shapes.length === 0
    ? selection.marks[0] : null;
  const handleHalf = (half: Point): Point => {
    const pad = Math.max(0, minSize) / 2;
    return [Math.max(half[0], pad), Math.max(half[1], pad)];
  };
  if (singleShape) {
    const extents = shapeExtents(singleShape);
    return {
      center: extents.center,
      rotation: (extents.rotation ?? 0) / DEGREES,
      half: extents.half,
      handleHalf: handleHalf(extents.half),
      mode: singleShape.type === 'circle' || singleShape.type === 'arc' ? 'uniform' : 'free',
      // 圆弧可三点整体旋转；圆旋转没有视觉意义，故不提供旋转手柄。
      rotatable: singleShape.type !== 'circle',
      minExtent: capMinExtent(shapeMinExtent(singleShape), extents.half)
    };
  }
  if (singleMark) {
    const extents = markExtents(singleMark);
    if (!extents) return null;
    // 圈选渲染有 3 world 半径下限；选择框与最小缩放必须用同一尺寸，不能缩到形状内部。
    const minExtent: Point = singleMark.shape === 'region'
      ? [REGION_MIN_RADIUS * 2, REGION_MIN_RADIUS * 2] : [2, 2];
    return {
      center: extents.center,
      rotation: (extents.rotation ?? 0) / DEGREES,
      half: extents.half,
      handleHalf: handleHalf(extents.half),
      mode: singleMark.shape === 'text' ? 'none' : 'free',
      rotatable: singleMark.shape === 'arrow' || singleMark.shape === 'pen',
      minExtent: singleMark.shape === 'text' ? [0, 0] : capMinExtent(minExtent, extents.half)
    };
  }
  // 多选没有可用的局部轴，直接用真实并集包围盒；padding 只扩手柄，不影响缩放基准。
  const bounds = selectionBounds(selection);
  if (!bounds) return null;
  const half: Point = [(bounds.max[0] - bounds.min[0]) / 2, (bounds.max[1] - bounds.min[1]) / 2];
  return {
    center: boundsCenter(bounds),
    rotation: 0,
    half,
    handleHalf: handleHalf(half),
    // 混合选择里只要含圆/圆弧或非轴向旋转的矩形/圈选，世界轴非等比缩放就无法表达；
    // 直接收成等比四角手柄，避免用户看到边手柄却拖不动。
    mode: selectionRequiresUniformTransform(selection) ? 'uniform' : 'free',
    // 文字不支持旋转；含文字的组选择也不提供旋转手柄。
    rotatable: !selection.marks.some(mark => mark.shape === 'text'),
    minExtent: capMinExtent(selectionMinExtent(selection), half)
  };
}

/** 世界轴非等比变换会破坏这些对象的局部正交性，只能等比缩放。 */
function selectionRequiresUniformTransform(selection: Selection): boolean {
  return selection.shapes.some(shape =>
    shape.type === 'circle' || shape.type === 'arc' ||
    (shape.type === 'rect' && !axisAlignedRotation(shape.rotation))) ||
    selection.marks.some(mark => mark.shape === 'region' && !axisAlignedRotation(mark.rotation));
}

function axisAlignedRotation(degrees = 0): boolean {
  const normalized = normalizeRotation(degrees) ?? 0;
  const mod = Math.abs(normalized % 90);
  return mod < 1e-6 || 90 - mod < 1e-6;
}

/** 多选缩放的全局下限：取所有成员类型要求的最大值，避免某一成员先坏掉。 */
function selectionMinExtent(selection: Selection): Point {
  let extent: Point = [2, 2];
  const widen = (next: Point): void => {
    extent = [Math.max(extent[0], next[0]), Math.max(extent[1], next[1])];
  };
  for (const shape of selection.shapes) widen(shapeMinExtent(shape));
  for (const mark of selection.marks) {
    if (mark.shape === 'region') widen([REGION_MIN_RADIUS * 2, REGION_MIN_RADIUS * 2]);
  }
  return extent;
}

/** 旧草稿可能本来就比产品下限小；夹取不能反过来把它们强制放大。 */
function capMinExtent(minExtent: Point, half: Point): Point {
  return [Math.min(minExtent[0], half[0] * 2), Math.min(minExtent[1], half[1] * 2)];
}

export function frameHandles(frame: TransformFrame): readonly ScaleHandle[] {
  if (frame.mode === 'none') return [];
  return frame.mode === 'uniform' ? CORNER_HANDLES : SCALE_HANDLES;
}

/** 旋转后的包围盒四角，供选中框与命中测试共用。 */
export function frameCorners(frame: TransformFrame): Point[] {
  return CORNER_HANDLES.map(handle => frameHandlePoint(frame, handle));
}

export function frameHandlePoint(frame: TransformFrame, handle: ScaleHandle): Point {
  const local = localHandlePoint(frame.handleHalf, handle);
  return frameToWorld(frame, local);
}

/** 旋转手柄在上边中点外侧 offsetWorld 处，位置随手柄框一起旋转。 */
export function frameRotationPoint(frame: TransformFrame, offsetWorld: number): Point {
  return frameToWorld(frame, [0, -frame.handleHalf[1] - offsetWorld]);
}

/**
 * 局部轴缩放比。pivot 取对侧手柄；圆/圆弧与 Shift 强制等比。
 * origin 是 pointerdown 的真实落点：小对象手柄外扩后，必须用它做比例基准，
 * 否则一按下就会把对象放大到 padding 尺寸。按真实半宽/半高夹取最小尺寸。
 */
export function frameScaleFactors(frame: TransformFrame, handle: ScaleHandle,
  pointer: Point, uniform: boolean, origin?: Point): {sx: number; sy: number} {
  const local = frameFromWorld(frame, pointer);
  const start = origin ? frameFromWorld(frame, origin) : localHandlePoint(frame.half, handle);
  const pivot = localHandlePoint(frame.half, oppositeHandle(handle));
  const hasX = handle.includes('e') || handle.includes('w');
  const hasY = handle.includes('n') || handle.includes('s');
  let sx = hasX && Math.abs(start[0] - pivot[0]) > MATRIX_EPSILON
    ? (local[0] - pivot[0]) / (start[0] - pivot[0]) : 1;
  let sy = hasY && Math.abs(start[1] - pivot[1]) > MATRIX_EPSILON
    ? (local[1] - pivot[1]) / (start[1] - pivot[1]) : 1;
  if (!Number.isFinite(sx)) sx = 1;
  if (!Number.isFinite(sy)) sy = 1;
  const forcedUniform = uniform || frame.mode === 'uniform';
  if (forcedUniform) {
    const factor = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    sx = factor;
    sy = factor;
  }
  sx = clampScale(sx, frame.half[0], frame.minExtent[0]);
  sy = clampScale(sy, frame.half[1], frame.minExtent[1]);
  if (forcedUniform) {
    const factor = Math.max(sx, sy);
    sx = factor;
    sy = factor;
  }
  return {sx, sy};
}

/** 世界矩阵：保持 frame 中心与旋转，沿局部轴围绕对侧手柄缩放。 */
export function frameScaleMatrix(frame: TransformFrame, sx: number, sy: number,
  handle?: ScaleHandle): AffineMatrix {
  const pivot = handle ? localHandlePoint(frame.half, oppositeHandle(handle)) : [0, 0] as Point;
  const localScale: AffineMatrix = {a: sx, b: 0, c: 0, d: sy,
    e: pivot[0] * (1 - sx), f: pivot[1] * (1 - sy)};
  const toWorld = multiplyMatrix(translationMatrix(frame.center[0], frame.center[1]),
    rotationMatrix([0, 0], frame.rotation));
  const fromWorld = multiplyMatrix(rotationMatrix([0, 0], -frame.rotation),
    translationMatrix(-frame.center[0], -frame.center[1]));
  return multiplyMatrix(multiplyMatrix(toWorld, localScale), fromWorld);
}

export function oppositeHandle(handle: ScaleHandle): ScaleHandle {
  switch (handle) {
    case 'nw': return 'se';
    case 'n': return 's';
    case 'ne': return 'sw';
    case 'e': return 'w';
    case 'se': return 'nw';
    case 's': return 'n';
    case 'sw': return 'ne';
    case 'w': return 'e';
  }
}

function localHandlePoint(half: Point, handle: ScaleHandle): Point {
  const x = handle.includes('e') ? half[0] : handle.includes('w') ? -half[0] : 0;
  const y = handle.includes('s') ? half[1] : handle.includes('n') ? -half[1] : 0;
  return [x, y];
}

function frameToWorld(frame: TransformFrame, local: Point): Point {
  const cos = Math.cos(frame.rotation);
  const sin = Math.sin(frame.rotation);
  return [frame.center[0] + local[0] * cos - local[1] * sin,
    frame.center[1] + local[0] * sin + local[1] * cos];
}

function frameFromWorld(frame: TransformFrame, world: Point): Point {
  const cos = Math.cos(frame.rotation);
  const sin = Math.sin(frame.rotation);
  const dx = world[0] - frame.center[0];
  const dy = world[1] - frame.center[1];
  return [dx * cos + dy * sin, -dx * sin + dy * cos];
}

function clampScale(factor: number, halfExtent: number, minExtent: number): number {
  if (!(halfExtent > 1e-9)) return Math.max(MIN_SCALE, factor);
  // minExtent 是全宽/全高；halfExtent 是半宽/半高。
  return Math.max(MIN_SCALE, minExtent / (halfExtent * 2), factor);
}

function shapeExtents(shape: Shape): {center: Point; half: Point; rotation?: number} {
  if (shape.type === 'rect') {
    return {
      center: [(shape.a[0] + shape.b[0]) / 2, (shape.a[1] + shape.b[1]) / 2],
      half: [Math.abs(shape.b[0] - shape.a[0]) / 2, Math.abs(shape.b[1] - shape.a[1]) / 2],
      rotation: shape.rotation ?? 0
    };
  }
  const bounds = boundsFromPoints(shapeBoundPoints(shape));
  return {center: boundsCenter(bounds!), half: boundsHalf(bounds!)};
}

function markExtents(mark: Mark): {center: Point; half: Point; rotation?: number} | null {
  if (mark.shape === 'region') {
    return {
      center: [(mark.a[0] + mark.b[0]) / 2, (mark.a[1] + mark.b[1]) / 2],
      // 与渲染/命中共用同一个半径下限：极小的旧圈选也不会出现“框在形状内部”。
      half: [Math.max(REGION_MIN_RADIUS, Math.abs(mark.b[0] - mark.a[0]) / 2),
        Math.max(REGION_MIN_RADIUS, Math.abs(mark.b[1] - mark.a[1]) / 2)],
      rotation: mark.rotation ?? 0
    };
  }
  const points = markBoundPoints(mark);
  if (!points.length) return null;
  const bounds = boundsFromPoints(points);
  // 运行时损坏草稿可能绕过 normalizeProject 直接进入选择框；无几何时宁可不出手柄，也不抛异常。
  return bounds ? {center: boundsCenter(bounds), half: boundsHalf(bounds)} : null;
}

function boundsHalf(bounds: WorldBounds): Point {
  return [(bounds.max[0] - bounds.min[0]) / 2, (bounds.max[1] - bounds.min[1]) / 2];
}

function shapeMinExtent(shape: Shape): Point {
  switch (shape.type) {
    case 'rect':
    case 'path':
      return [4, 4];
    case 'circle':
      // 半径最小 1 → 直径 2。
      return [2, 2];
    case 'arc':
      return [4, 4];
    default:
      return [2, 2];
  }
}

/** 旋转增量吸附到 stepDegrees 的整数倍；默认 15°。 */
export function snapAngle(radians: number, stepDegrees = 15): number {
  if (!Number.isFinite(radians) || stepDegrees <= 0) return radians;
  const degrees = radians * 180 / Math.PI;
  return Math.round(degrees / stepDegrees) * stepDegrees * Math.PI / 180;
}

/**
 * Shift 旋转吸附：把“起始角 + 增量”吸附到绝对网格后再换算回增量。
 * 已自由旋转 7° 的对象因此落到 15°/30°，而不是 7°+15k。
 */
export function snapRotationDelta(startRotation: number, delta: number, stepDegrees = 15): number {
  if (!Number.isFinite(startRotation) || !Number.isFinite(delta)) return delta;
  return snapAngle(startRotation + delta, stepDegrees) - startRotation;
}

export function handleFromTarget(target: Element | null): TransformHandle | null {
  const node = target?.closest<SVGElement>('[data-transform-handle]');
  const handle = node?.dataset.transformHandle;
  return handle === 'rotate' || SCALE_HANDLES.some(item => item === handle)
    ? handle as TransformHandle : null;
}

function shapeBoundPoints(shape: Shape): Point[] {
  switch (shape.type) {
    case 'line':
      return shape.points;
    case 'rect':
      return rectCorners(shape);
    case 'circle': {
      const [cx, cy] = shape.center;
      const radius = Math.abs(shape.radius ?? 0);
      return [[cx - radius, cy - radius], [cx + radius, cy + radius]];
    }
    case 'arc':
      return arcPoints(shape);
    case 'path':
      return shape.polygons.flat(2) as Point[];
    default:
      return [];
  }
}

function markBoundPoints(mark: Mark): Point[] {
  switch (mark.shape) {
    case 'pen':
      return mark.points;
    case 'region': {
      const center: Point = [(mark.a[0] + mark.b[0]) / 2, (mark.a[1] + mark.b[1]) / 2];
      const radii: Point = [Math.max(REGION_MIN_RADIUS, Math.abs(mark.a[0] - mark.b[0]) / 2),
        Math.max(REGION_MIN_RADIUS, Math.abs(mark.a[1] - mark.b[1]) / 2)];
      return mark.rotation ? ellipseRing(center, radii, mark.rotation, 48) : [mark.a, mark.b];
    }
    case 'arrow':
      return markGeometry(mark, false).points;
    case 'text':
      return textLabelCorners(mark);
    default:
      return [];
  }
}
