import {arcCircle, MAX_COORDINATE, rectCorners, rotatePoint} from './geometry.ts';
import type {Point, Shape} from './geometry.ts';
import type {Mark, Project} from './project.ts';
import type {SnapKind} from './renderer.ts';
import {screenConstant} from './viewport.ts';

/** 与产品约定一致：阈值始终按屏幕 CSS 像素计算，不随缩放变化。 */
export const DEFAULT_SNAP_THRESHOLD_PX = 10;
/**
 * 栅格间距至少是捕捉阈值的两倍才参与吸附。低缩放时网格 LOD 可能只剩 9–10px，
 * 此时任何点都落在阈值内，会让非 Alt 绘制全部被强行量化到栅格。
 */
const MIN_GRID_SNAP_SCREEN_SPACING = DEFAULT_SNAP_THRESHOLD_PX * 2;

/** 空间索引格子按 world 单位划分；只影响候选预筛选，不影响最终精度。 */
const INDEX_CELL = 64;
/** 单条复杂路径最多保留的候选密度；布尔结果可能有上千顶点，不能全量进索引。 */
const MAX_POLYLINE_CANDIDATES = 128;
/** 单条路径参与索引的 ring 上限；超出时按步长均匀抽样，保留空间分布。 */
const MAX_PATH_SNAP_RINGS = 512;
/** 单条路径的候选硬上限；避免高密度 payload 一次生成十几万 feature。 */
const MAX_PATH_SNAP_FEATURES = 4_096;
/** 整个项目进入捕捉索引的 feature 硬上限；超出时停止追加，指针交互仍可用。 */
export const MAX_SNAP_FEATURES = 50_000;
/** 防御异常 scale/threshold 造成的超大范围遍历；正常 10%–800% 远低于该值。 */
const MAX_QUERY_CELLS_PER_AXIS = 64;
/** 世界阈值上限；超过它说明 scale/threshold 已失真，不能继续扩大查询范围。 */
const MAX_SNAP_THRESHOLD_WORLD = INDEX_CELL * MAX_QUERY_CELLS_PER_AXIS;
const DISTANCE_EPSILON = 1e-12;

/**
 * 一条可捕捉特征。同一图元的端点/中点等会展开成多条记录，
 * 这样空间索引可以按特征点分桶，pointermove 无需回扫整条折线。
 */
export interface SnapEntity {
  readonly id: string;
  readonly type: Exclude<SnapKind, 'grid'>;
  readonly point: Point;
}

export interface SnapGrid {
  spacing: number;
  origin: Point;
}

export interface SnapOptions {
  /** 屏幕 CSS 像素 / world 单位；与 BoardViewport.zoom 一致。 */
  scale: number;
  thresholdPx?: number;
  grid?: SnapGrid | null;
  /** 正在拖动/变换的对象不能吸到自己身上；手势开始时构建一次，pointermove 只做 O(1) 查询。 */
  exclude?: ReadonlySet<string>;
  enabled?: boolean;
}

export interface SnapResult {
  point: Point;
  type: SnapKind;
  entityId: string | null;
}

/**
 * 固定优先级，不随图元/选择顺序变化。
 * intersection 已预留；index 后续加入交点特征时自动获得该优先级。
 */
const SNAP_PRIORITY: Record<SnapKind, number> = {
  endpoint: 0,
  midpoint: 1,
  center: 2,
  quadrant: 3,
  intersection: 4,
  nearest: 5,
  grid: 6
};

export const SNAP_LABELS: Record<SnapKind, string> = {
  endpoint: '端点',
  midpoint: '中点',
  center: '圆心',
  quadrant: '象限点',
  intersection: '交点',
  nearest: '附近',
  grid: '栅格'
};

/**
 * @entry 捕捉内核：纯函数，只读候选特征与 rawPoint，不碰 DOM。
 * 同类型候选取最近；距离相同时按 entityId / 坐标稳定排序，保证结果可复现。
 */
export function resolveSnap(entities: readonly SnapEntity[], rawPoint: Point,
  options: SnapOptions): SnapResult | null {
  if (options.enabled === false) return null;
  if (!isUsablePoint(rawPoint)) return null;
  const threshold = snapThresholdWorld(options);
  if (!(threshold >= 0)) return null;
  const thresholdSq = threshold * threshold;

  let bestType: SnapKind | null = null;
  let bestId = '';
  let bestPoint: Point = rawPoint;
  let bestPriority = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const entity of entities) {
    if (options.exclude?.has(entity.id)) continue;
    const dx = entity.point[0] - rawPoint[0];
    const dy = entity.point[1] - rawPoint[1];
    const distance = dx * dx + dy * dy;
    if (distance > thresholdSq) continue;
    const priority = SNAP_PRIORITY[entity.type];
    if (priority > bestPriority) continue;
    if (priority === bestPriority &&
      !beatsCandidate(distance, entity.id, entity.point, bestDistance, bestId, bestPoint)) continue;
    bestType = entity.type;
    bestId = entity.id;
    bestPoint = entity.point;
    bestPriority = priority;
    bestDistance = distance;
  }

  // 栅格优先级最低；已经有更优先的特征命中时无需再算栅格。
  if (!bestType && options.grid && gridWideEnoughForSnap(options.grid, options.scale)) {
    const point = nearestGridPoint(rawPoint, options.grid);
    if (point) {
      const dx = point[0] - rawPoint[0];
      const dy = point[1] - rawPoint[1];
      if (dx * dx + dy * dy <= thresholdSq) {
        bestType = 'grid';
        bestPoint = point;
      }
    }
  }

  return bestType ? {point: [bestPoint[0], bestPoint[1]], type: bestType,
    entityId: bestType === 'grid' ? null : bestId} : null;
}

/**
 * @entry 从项目生成候选特征。只在项目提交/加载时调用，pointermove 不重建。
 * 画笔只取首尾点，避免一笔数百个采样点塞满索引。
 *
 * 本轮不生成交点：成对线段求交需要额外的线段索引，否则会把局部查询退化成
 * 邻近图元两两比较。SNAP_PRIORITY 已给 intersection 留好固定位置，
 * 后续在 SnapIndex.resolve 里把交点候选并入 candidates 即可，不影响现有优先级。
 */
export function snapEntities(project: Project): SnapEntity[] {
  const entities: SnapEntity[] = [];
  for (const shape of project.shapes ?? []) {
    appendEntities(entities, shapeEntities(shape));
    if (entities.length >= MAX_SNAP_FEATURES) return entities;
  }
  for (const mark of project.marks ?? []) {
    appendEntities(entities, markEntities(mark));
    if (entities.length >= MAX_SNAP_FEATURES) return entities;
  }
  return entities;
}

/** 逐项追加，避免 `push(...大数组)` 在 V8 上触发 Maximum call stack size exceeded。 */
function appendEntities(target: SnapEntity[], source: readonly SnapEntity[]): void {
  const limit = MAX_SNAP_FEATURES - target.length;
  for (let index = 0; index < source.length && index < limit; index++) {
    target.push(source[index]);
  }
}

/**
 * @entry 空间索引。按 world 格子预筛候选，pointermove 只在光标周围取桶；
 * candidates 数组与结果对象均复用，不在移动过程中批量分配。
 */
export class SnapIndex {
  private readonly cells = new Map<number, Map<number, SnapEntity[]>>();
  private readonly candidates: SnapEntity[] = [];
  private featureCount = 0;
  private candidateCount = 0;

  rebuild(project: Project): void {
    this.cells.clear();
    this.featureCount = 0;
    for (const entity of snapEntities(project)) {
      const cellX = Math.floor(entity.point[0] / INDEX_CELL);
      const cellY = Math.floor(entity.point[1] / INDEX_CELL);
      let column = this.cells.get(cellX);
      if (!column) {
        column = new Map();
        this.cells.set(cellX, column);
      }
      let bucket = column.get(cellY);
      if (!bucket) {
        bucket = [];
        column.set(cellY, bucket);
      }
      bucket.push(entity);
      this.featureCount++;
    }
  }

  get size(): number {
    return this.featureCount;
  }

  /** 最近一次 resolve 实际扫描的候选数；用于性能测试与排查。 */
  get lastCandidateCount(): number {
    return this.candidateCount;
  }

  resolve(rawPoint: Point, options: SnapOptions): SnapResult | null {
    this.candidateCount = 0;
    if (options.enabled === false) return null;
    // pointermove 路径：SVG 矩阵异常时 boardPoint 可能返回非有限值。
    // 若让 Infinity/超大浮点进入格子循环，cellX++ 会停在原值导致死循环。
    if (!isUsablePoint(rawPoint)) return null;
    const threshold = snapThresholdWorld(options);
    if (!(threshold >= 0)) return null;
    const minX = Math.floor((rawPoint[0] - threshold) / INDEX_CELL);
    const maxX = Math.floor((rawPoint[0] + threshold) / INDEX_CELL);
    const minY = Math.floor((rawPoint[1] - threshold) / INDEX_CELL);
    const maxY = Math.floor((rawPoint[1] + threshold) / INDEX_CELL);
    if (![minX, maxX, minY, maxY].every(Number.isSafeInteger)) return null;
    if (maxX - minX + 1 > MAX_QUERY_CELLS_PER_AXIS ||
      maxY - minY + 1 > MAX_QUERY_CELLS_PER_AXIS) return null;

    this.candidates.length = 0;
    for (let cellX = minX; cellX <= maxX; cellX++) {
      const column = this.cells.get(cellX);
      if (!column) continue;
      for (let cellY = minY; cellY <= maxY; cellY++) {
        const bucket = column.get(cellY);
        if (!bucket) continue;
        for (const entity of bucket) this.candidates.push(entity);
      }
    }
    this.candidateCount = this.candidates.length;
    return resolveSnap(this.candidates, rawPoint, options);
  }
}

export function createSnapIndex(project?: Project): SnapIndex {
  const index = new SnapIndex();
  if (project) index.rebuild(project);
  return index;
}

/**
 * 屏幕阈值折算成 world 半径；scale 非法时按 1 处理，保证降级行为可预测。
 * 非有限阈值返回 NaN（调用方按未命中处理），有限但离谱的阈值夹到查询安全上限。
 */
export function snapThresholdWorld(options: SnapOptions): number {
  const px = options.thresholdPx ?? DEFAULT_SNAP_THRESHOLD_PX;
  if (!Number.isFinite(px) || px < 0) return Number.NaN;
  const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1;
  const threshold = screenConstant(px, scale);
  if (!Number.isFinite(threshold)) return Number.NaN;
  return Math.min(threshold, MAX_SNAP_THRESHOLD_WORLD);
}

/** 超出几何硬上限的指针已不可能命中合法内容，直接按未命中处理。 */
function isUsablePoint(point: Point): boolean {
  return Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]) &&
    Math.abs(point[0]) <= MAX_COORDINATE && Math.abs(point[1]) <= MAX_COORDINATE;
}

function beatsCandidate(distance: number, id: string, point: Point, bestDistance: number,
  bestId: string, bestPoint: Point): boolean {
  if (distance < bestDistance - DISTANCE_EPSILON) return true;
  if (distance > bestDistance + DISTANCE_EPSILON) return false;
  if (id !== bestId) return id < bestId;
  if (point[0] !== bestPoint[0]) return point[0] < bestPoint[0];
  return point[1] < bestPoint[1];
}

function gridWideEnoughForSnap(grid: SnapGrid, scale: number): boolean {
  const usableScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Number.isFinite(grid.spacing) && grid.spacing > 0 &&
    grid.spacing * usableScale >= MIN_GRID_SNAP_SCREEN_SPACING;
}

function nearestGridPoint(rawPoint: Point, grid: SnapGrid): Point | null {
  const {spacing, origin} = grid;
  if (!Number.isFinite(spacing) || spacing <= 0) return null;
  const x = origin[0] + Math.round((rawPoint[0] - origin[0]) / spacing) * spacing;
  const y = origin[1] + Math.round((rawPoint[1] - origin[1]) / spacing) * spacing;
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function shapeEntities(shape: Shape): SnapEntity[] {
  switch (shape.type) {
    case 'line':
      return polylineEntities(shape.id, shape.points ?? [], MAX_POLYLINE_CANDIDATES);
    case 'rect':
      return rectEntities(shape);
    case 'circle':
      return circleEntities(shape);
    case 'arc':
      return arcEntities(shape);
    case 'path':
      return pathEntities(shape);
    default:
      return [];
  }
}

function markEntities(mark: Mark): SnapEntity[] {
  switch (mark.shape) {
    case 'pen':
      return endpointEntities(mark.id, [mark.points[0], mark.points.at(-1)]);
    case 'region':
      return ellipseEntities(mark.id, mark.a, mark.b, mark.rotation ?? 0);
    case 'arrow': {
      const entities: SnapEntity[] = [];
      pushPoint(entities, mark.id, 'endpoint', mark.a);
      pushPoint(entities, mark.id, 'endpoint', mark.b);
      pushPoint(entities, mark.id, 'midpoint', midpoint(mark.a, mark.b));
      return entities;
    }
    case 'text':
      return endpointEntities(mark.id, [mark.a]);
    default:
      return [];
  }
}

function rectEntities(shape: Extract<Shape, {type: 'rect'}>): SnapEntity[] {
  const corners = rectCorners(shape);
  const entities = endpointEntities(shape.id, corners);
  corners.forEach((corner, index) => {
    const next = corners[(index + 1) % corners.length];
    pushPoint(entities, shape.id, 'midpoint', midpoint(corner, next));
  });
  return entities;
}

function circleEntities(shape: Extract<Shape, {type: 'circle'}>): SnapEntity[] {
  const entities: SnapEntity[] = [];
  pushPoint(entities, shape.id, 'center', shape.center);
  const radius = Math.abs(shape.radius ?? 0);
  if (radius > 1e-6) {
    const [cx, cy] = shape.center;
    for (const point of [[cx + radius, cy], [cx, cy + radius], [cx - radius, cy], [cx, cy - radius]] as Point[]) {
      pushPoint(entities, shape.id, 'quadrant', point);
    }
  }
  return entities;
}

function arcEntities(shape: Extract<Shape, {type: 'arc'}>): SnapEntity[] {
  const points = shape.points ?? [];
  const entities = endpointEntities(shape.id, [points[0], points.at(-1)]);
  const circle = arcCircle(points);
  if (!circle) return entities;
  const {center, radius, start, end, sweep} = circle;
  pushPoint(entities, shape.id, 'center', center);
  const span = sweep ? turn(end - start) : turn(start - end);
  const direction = sweep ? 1 : -1;
  pushPoint(entities, shape.id, 'midpoint',
    [center[0] + radius * Math.cos(start + direction * span / 2),
      center[1] + radius * Math.sin(start + direction * span / 2)]);
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 3 / 2]) {
    if (angleWithinArc(angle, start, span, sweep)) {
      pushPoint(entities, shape.id, 'quadrant',
        [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
    }
  }
  return entities;
}

function pathEntities(shape: Extract<Shape, {type: 'path'}>): SnapEntity[] {
  const polygons = shape.polygons ?? [];
  if (!polygons.length) return [];
  const allRings: Point[][] = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon)) continue;
    for (const ring of polygon) if (Array.isArray(ring) && ring.length) allRings.push(ring);
  }
  if (!allRings.length) return [];
  // 高密度多环路径（布尔/外部 payload）按步长均匀抽样，保留整条路径的空间分布。
  const stride = Math.max(1, Math.ceil(allRings.length / MAX_PATH_SNAP_RINGS));
  const rings = stride === 1 ? allRings : allRings.filter((_, index) => index % stride === 0);
  const last = allRings.at(-1)!;
  if (rings.at(-1) !== last) rings.push(last);
  // 总预算固定，孔洞/布尔结果再多也不会让单个图元撑爆索引。
  const perRing = Math.max(4, Math.floor(MAX_POLYLINE_CANDIDATES / rings.length));
  const entities: SnapEntity[] = [];
  for (const ring of rings) {
    for (const entity of polylineEntities(shape.id, ring, perRing)) {
      if (entities.length >= MAX_PATH_SNAP_FEATURES) return entities;
      entities.push(entity);
    }
  }
  return entities;
}

function ellipseEntities(id: string, a: Point, b: Point, rotationDegrees = 0): SnapEntity[] {
  const center: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const rx = Math.max(3, Math.abs(a[0] - b[0]) / 2);
  const ry = Math.max(3, Math.abs(a[1] - b[1]) / 2);
  const radians = rotationDegrees * Math.PI / 180;
  const entities: SnapEntity[] = [];
  pushPoint(entities, id, 'center', center);
  for (const point of [[center[0] + rx, center[1]], [center[0], center[1] + ry],
    [center[0] - rx, center[1]], [center[0], center[1] - ry]] as Point[]) {
    pushPoint(entities, id, 'quadrant', rotatePoint(point, center, radians));
  }
  return entities;
}

/**
 * 折线候选：顶点做端点，边做中点。超长路径按步长抽稀，保持空间分布而不是只取开头。
 * 首尾点始终保留，线段两端闭合时也不会漏掉最后一处端点。
 */
function polylineEntities(id: string, points: readonly Point[], cap: number): SnapEntity[] {
  const valid = points.filter(point => point && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (!valid.length) return [];
  const entities: SnapEntity[] = [];
  const stride = Math.max(1, Math.ceil(valid.length / Math.max(1, cap)));
  for (let index = 0; index < valid.length; index += stride) {
    pushPoint(entities, id, 'endpoint', valid[index]);
    const next = valid[index + 1];
    if (next) pushPoint(entities, id, 'midpoint', midpoint(valid[index], next));
  }
  const last = valid.at(-1)!;
  if ((valid.length - 1) % stride !== 0) pushPoint(entities, id, 'endpoint', last);
  return entities;
}

function endpointEntities(id: string, points: readonly (Point | undefined)[]): SnapEntity[] {
  const entities: SnapEntity[] = [];
  for (const point of points) {
    if (point) pushPoint(entities, id, 'endpoint', point);
  }
  return entities;
}

function pushPoint(entities: SnapEntity[], id: string,
  type: Exclude<SnapKind, 'grid'>, point: Point): void {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
  entities.push({id, type, point});
}

function midpoint(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function turn(angle: number): number {
  return (angle % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
}

function angleWithinArc(angle: number, start: number, span: number, sweep: 0 | 1): boolean {
  const offset = sweep ? turn(angle - start) : turn(start - angle);
  return offset <= span + 1e-9;
}
