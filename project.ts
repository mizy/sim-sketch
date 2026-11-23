import {clampedPoint, expandDegenerateBox, isSafePoint, MAX_PROJECT_OBJECTS, MAX_PROJECT_VERTICES,
  MIN_REGION_EXTENT, normalizeRotation, sanitizeShapeGeometry, sanitizedPointList,
  shapeVertexCount} from './geometry.ts';
import type {GeometryRepair, Point, Shape} from './geometry.ts';
import {sanitizeBezierPath} from './bezier.ts';
import type {BezierPath} from './bezier.ts';
import {normalizeMarkWidth, normalizeShapeStrokeWidth} from './mark-width.ts';
import {clampMarkStyleSize, DEFAULT_ARROW_SIZE, DEFAULT_TEXT_FONT_SIZE} from './mark-style.ts';

export type MarkShape = 'pen' | 'region' | 'arrow' | 'text';
export type MarkKind = 'fixed' | 'force' | 'pressure' | 'structure' | 'note' | 'other';
export type MarkSource = 'manual' | 'ai';

export interface MarkBase {
  id: string;
  shape: MarkShape;
  kind: MarkKind;
  label: string;
  value: number | null;
  unit: string;
  direction: string;
  question: string;
  confirmed: boolean;
  source: MarkSource;
  layerId: string;
  color?: string;
}

export interface PenMark extends MarkBase {
  shape: 'pen';
  /** 离散采样：未拟合时是原始手绘点，拟合后是曲线的自适应采样。 */
  points: Point[];
  /**
   * 自动拟合得到的可编辑贝塞尔路径（可选）。
   * points 始终保留曲线采样，命中、包围盒与旧渲染后端不依赖该字段。
   */
  curve?: BezierPath;
  /** 绘制时的线宽；缺省时按 LEGACY_MARK_WIDTH 回退。 */
  width?: number;
}

export interface RegionMark extends MarkBase {
  shape: 'region';
  a: Point;
  b: Point;
  width?: number;
  /** 旋转椭圆角度（度）；可选，旧草稿没有该字段时保持轴对齐。 */
  rotation?: number;
}

export interface ArrowMark extends MarkBase {
  shape: 'arrow';
  a: Point;
  b: Point;
  width?: number;
  /** 箭头头部长度（模型单位，8–96）；缺省时沿用旧公式，兼容旧草稿。 */
  size?: number;
}

export interface TextMark extends MarkBase {
  shape: 'text';
  a: Point;
  /** 文字字号（px，8–96）；缺省按 22 渲染，兼容旧草稿。 */
  fontSize?: number;
}

export type Mark = PenMark | RegionMark | ArrowMark | TextMark;

export interface Layer {
  id: string;
  name: string;
  opacity: number;
}

export interface Project {
  reference: string | null;
  referenceLayerId?: string;
  layers: Layer[];
  marks: Mark[];
  shapes: Shape[];
}

export interface StoredMark extends Partial<Omit<MarkBase, 'shape'>> {
  id: string;
  shape?: MarkShape;
  a?: Point;
  b?: Point;
  points?: Point[];
  /** 手绘拟合曲线；损坏时只移除曲线，保留原始 points。 */
  curve?: BezierPath;
  /** 旧草稿没有该字段；加载时由 normalizeProject 补齐。 */
  width?: number;
  rotation?: number;
  size?: number;
  fontSize?: number;
}

export type StoredProject = Partial<Omit<Project, 'marks' | 'shapes' | 'layers'>> & {
  layers?: Layer[];
  marks?: StoredMark[];
  shapes?: Shape[];
};

let database: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('sim-sketch', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

export async function readProject(): Promise<StoredProject | undefined> {
  const db = await openDatabase();
  return new Promise<StoredProject | undefined>((resolve, reject) => {
    const request = db.transaction('projects').objectStore('projects').get('draft');
    request.onsuccess = () => resolve(request.result as StoredProject | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function saveProject(project: Project): Promise<void> {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('projects', 'readwrite');
    transaction.objectStore('projects').put(project, 'draft');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

export const defaultLayerId = 'layer-default';

export const newLayer = (name: string): Layer => ({id: crypto.randomUUID(), name, opacity: 1});

/** 本地草稿迁移报告；调用方据此提示“坐标已夹取/损坏对象已移除”，不再静默丢数据。 */
export interface ProjectRepair extends GeometryRepair {
  droppedObjects: number;
}

export function normalizeProject(project: StoredProject): Project {
  return normalizeProjectWithRepair(project).project;
}

/**
 * @entry 本地草稿/提交规范化。有限越界坐标夹到安全边界；
 * 非有限坐标或结构性损坏对象才移除，并通过 repair 报告给用户。
 */
export function normalizeProjectWithRepair(project: StoredProject): {project: Project; repair: ProjectRepair} {
  const repair: ProjectRepair = {clamped: 0, dropped: 0, droppedObjects: 0};
  let layers: Layer[] = project.layers?.length ? project.layers : [{id: defaultLayerId, name: '图层 1', opacity: 1}];
  const fallback = layers[0].id;
  const ids = new Set(layers.map(layer => layer.id));
  let referenceLayerId = project.referenceLayerId;
  if (project.reference && !ids.has(referenceLayerId ?? '')) {
    // 旧草稿可能已有 layer-reference 图层但没写 referenceLayerId：复用它，避免重复插入。
    referenceLayerId = 'layer-reference';
    if (!ids.has(referenceLayerId)) {
      ids.add(referenceLayerId);
      layers = [{id: referenceLayerId, name: '参考图片', opacity: 1}, ...layers];
    }
  }
  // IndexedDB 里的旧草稿可能混入 null/非对象元素；先过滤，后续才能安全读取字段。
  const rawMarks = project.marks ?? [];
  const rawShapes = project.shapes ?? [];
  const storedMarks = rawMarks.filter((mark): mark is StoredMark =>
    typeof mark === 'object' && mark !== null);
  const storedShapes = rawShapes.filter((shape): shape is Shape =>
    typeof shape === 'object' && shape !== null);
  repair.droppedObjects += rawMarks.length - storedMarks.length +
    rawShapes.length - storedShapes.length;
  // 这里只做几何/字段清洗，绝不按全局预算截断：本地草稿的删除必须显式发生，
  // 否则“画一个新对象 → normalize 丢掉末尾旧对象”会变成不可恢复的数据丢失。
  const marks = storedMarks.map(mark => {
    const withLayer = ids.has(mark.layerId ?? '') ? mark : {...mark, layerId: fallback};
    // 只给画笔/圈选/箭头补线宽；文字保持原样，未知 shape 由 sanitizeStoredMark 丢弃并计数。
    const normalized = withLayer.shape === 'pen' || withLayer.shape === 'region' || withLayer.shape === 'arrow'
      ? normalizeMarkWidthFor(withLayer)
      : withLayer;
    return sanitizeStoredMark(normalizeMarkStyleFields(normalized), repair);
  }).filter((mark): mark is StoredMark => mark !== null);
  const shapes = storedShapes.map(shape => {
    const withLayer: Shape = ids.has(shape.layerId) ? shape : {...shape, layerId: fallback};
    // 新版图形线宽可被滑块写入；NaN/字符串/非正数按旧图形默认值兜底，避免渲染和命中同时失效。
    const strokeWidth = normalizeShapeStrokeWidth(withLayer.strokeWidth);
    const withWidth: Shape = withLayer.strokeWidth === strokeWidth ? withLayer : {...withLayer, strokeWidth};
    return sanitizeShapeGeometry(normalizeShapeRotation(withWidth), Number.POSITIVE_INFINITY, repair);
  }).filter((shape): shape is Shape => {
    if (shape) return true;
    repair.droppedObjects++;
    return false;
  });
  return {repair, project: {...project, reference: project.reference ?? null, layers, referenceLayerId,
    marks: marks as Mark[], shapes}};
}

/** 项目规模（对象数与顶点数）；提交前用它决定是否拒绝新增，而不是事后截断。 */
export function projectSize(project: Pick<Project, 'shapes' | 'marks'>): {objects: number; vertices: number} {
  let vertices = 0;
  for (const shape of project.shapes) vertices += shapeVertexCount(shape);
  for (const mark of project.marks) {
    vertices += mark.shape === 'pen' ? mark.points.length :
      mark.shape === 'text' ? 1 : 2;
  }
  return {objects: project.shapes.length + project.marks.length, vertices};
}

export function projectWithinLimits(project: Pick<Project, 'shapes' | 'marks'>): boolean {
  const {objects, vertices} = projectSize(project);
  return objects <= MAX_PROJECT_OBJECTS && vertices <= MAX_PROJECT_VERTICES;
}

export const PROJECT_LIMIT_NOTICE =
  `草稿已达上限（${MAX_PROJECT_OBJECTS} 个对象 / ${MAX_PROJECT_VERTICES} 个顶点），本次修改未保存；请删除部分内容或导出后清理。`;

export const PROJECT_REPAIR_NOTICE =
  '草稿中有超出安全范围的坐标，已夹取到可编辑范围；无法恢复的损坏点已移除。';

/** 线宽补齐后仍把旋转圈选收敛到合法角度；返回同一个对象时保持引用稳定。 */
function normalizeMarkWidthFor(mark: StoredMark): StoredMark {
  const shape = mark.shape as 'pen' | 'region' | 'arrow';
  const width = normalizeMarkWidth(shape, mark.width);
  const withWidth: StoredMark = mark.width === width ? mark : {...mark, width};
  return withWidth.shape === 'region' ? normalizeRegionRotation(withWidth) : withWidth;
}

/** 本地草稿的标注几何迁移；未知 shape 无法渲染/变换，丢弃并计入 repair。 */
function sanitizeStoredMark(mark: StoredMark, repair: ProjectRepair): StoredMark | null {
  const bound = (point: Point | undefined): Point | null => {
    if (isSafePoint(point)) return point;
    const result = clampedPoint(point);
    if (!result) {
      repair.dropped++;
      return null;
    }
    if (result.clamped) repair.clamped++;
    return result.point;
  };
  switch (mark.shape) {
    case 'pen': {
      const points = sanitizedPointList(mark.points, 1, Number.POSITIVE_INFINITY, repair);
      if (!points) repair.droppedObjects++;
      if (!points) return null;
      const withPoints = points === mark.points ? mark : {...mark, points};
      if (!('curve' in withPoints)) return withPoints;
      // 曲线损坏时回退原始手绘，不丢整条笔迹；合法曲线保持局部点引用。
      const curve = sanitizeBezierPath(withPoints.curve, value => {
        if (isSafePoint(value)) return value;
        const result = clampedPoint(value);
        if (!result) {
          repair.dropped++;
          return null;
        }
        if (result.clamped) repair.clamped++;
        return result.point;
      });
      if (curve) return {...withPoints, curve};
      repair.dropped++;
      const {curve: _ignored, ...withoutCurve} = withPoints;
      return withoutCurve;
    }
    case 'region':
    case 'arrow': {
      const a = bound(mark.a);
      const b = bound(mark.b);
      if (!a || !b) {
        repair.droppedObjects++;
        return null;
      }
      if (mark.shape === 'arrow') {
        return a === mark.a && b === mark.b ? mark : {...mark, a, b};
      }
      // 零尺寸圈选能生成选择框却无法被 transformMark 表达；迁移时按可见下限居中展开。
      const box = expandDegenerateBox(a, b, MIN_REGION_EXTENT, MIN_REGION_EXTENT);
      if (box.changed) repair.clamped++;
      return a === mark.a && b === mark.b && !box.changed
        ? mark : {...mark, a: box.a, b: box.b};
    }
    case 'text': {
      const a = bound(mark.a);
      if (!a) repair.droppedObjects++;
      return a ? (a === mark.a ? mark : {...mark, a}) : null;
    }
    default:
      // 旧草稿/手工损坏数据里的未知 shape 不能进入 Mark[]：选中时 markExtents 无几何可读，
      // 曾会让 renderAnnotations/selectionFrame 在页面加载后直接抛 TypeError。
      repair.droppedObjects++;
      return null;
  }
}

/**
 * 旧草稿没有 rotation 时不写入默认值；只有显式出现该字段才收敛。
 * 非法值直接移除，避免 NaN 让 shapePath / 命中路径一起失效。
 */
function normalizeShapeRotation(shape: Shape): Shape {
  if (shape.type !== 'rect' || !('rotation' in shape)) return shape;
  const rotation = normalizeRotation(shape.rotation);
  if (rotation === shape.rotation) return shape;
  if (rotation === null) {
    const {rotation: _ignored, ...rest} = shape;
    return rest;
  }
  return {...shape, rotation};
}

function normalizeRegionRotation(mark: StoredMark): StoredMark {
  if (!('rotation' in mark)) return mark;
  const rotation = normalizeRotation(mark.rotation);
  if (rotation === mark.rotation) return mark;
  if (rotation === null) {
    const {rotation: _ignored, ...rest} = mark;
    return rest;
  }
  return {...mark, rotation};
}

/**
 * 箭头/文字尺寸是独立样式字段：旧草稿缺失时不补字段（保持旧观感与对象引用），
 * 只有显式出现才夹取到 8–96；非法值回退各自默认值。
 */
function normalizeMarkStyleFields(mark: StoredMark): StoredMark {
  if (mark.shape === 'arrow' && 'size' in mark) {
    const size = clampMarkStyleSize(mark.size) ?? DEFAULT_ARROW_SIZE;
    return size === mark.size ? mark : {...mark, size};
  }
  if (mark.shape === 'text' && 'fontSize' in mark) {
    const fontSize = clampMarkStyleSize(mark.fontSize) ?? DEFAULT_TEXT_FONT_SIZE;
    return fontSize === mark.fontSize ? mark : {...mark, fontSize};
  }
  return mark;
}

export const emptyProject = (): Project => ({
  reference: null, layers: [{id: defaultLayerId, name: '图层 1', opacity: 1}], marks: [], shapes: []
});

interface MarkGeometry {
  pen: {points: Point[]};
  region: {a: Point; b: Point};
  arrow: {a: Point; b: Point};
  text: {a: Point};
}

export type MarkFields<S extends MarkShape> =
  Partial<Omit<MarkBase, 'id' | 'shape'>> & MarkGeometry[S] &
  (S extends 'text' ? {fontSize?: number} : {width?: number}) &
  (S extends 'arrow' ? {size?: number} : object);

export function newMark(shape: 'pen', fields: MarkFields<'pen'>): PenMark;
export function newMark(shape: 'region', fields: MarkFields<'region'>): RegionMark;
export function newMark(shape: 'arrow', fields: MarkFields<'arrow'>): ArrowMark;
export function newMark(shape: 'text', fields: MarkFields<'text'>): TextMark;
export function newMark(shape: MarkShape, fields: MarkFields<MarkShape>): Mark {
  const mark: Mark = {
    id: crypto.randomUUID(),
    shape,
    kind: 'note',
    label: '',
    value: null,
    unit: '',
    direction: '',
    question: '',
    confirmed: false,
    source: 'manual',
    layerId: defaultLayerId,
    ...fields
  } as Mark;
  return mark;
}

export function demoProject(): Project {
  return {
    reference: 'demo',
    layers: [{id: defaultLayerId, name: '图层 1', opacity: 1}],
    marks: [
      newMark('region', {a: [220, 181], b: [393, 445], kind: 'fixed', label: '左侧安装面'}),
      newMark('arrow', {a: [672, 175], b: [672, 348], kind: 'force', label: '右侧上表面 · 总载荷均布',
        value: 500, unit: 'N', question: '图中向下对应模型 −Z 还是重力方向？'})
    ],
    shapes: []
  };
}

export const markKinds: Record<MarkKind, {label: string; color: string}> = {
  fixed: {label: '固定约束', color: '#087b72'},
  force: {label: '力', color: '#713ad0'},
  pressure: {label: '压力', color: '#2766c5'},
  structure: {label: '结构', color: '#b74730'},
  note: {label: '备注', color: '#9f6415'},
  other: {label: '其他条件', color: '#65748e'}
};

export function markColor(mark: Pick<Mark, 'kind' | 'color'>): string {
  if (typeof mark.color === 'string' && /^#[0-9a-f]{6}$/i.test(mark.color)) return mark.color.toLowerCase();
  return (markKinds[mark.kind] ?? markKinds.note).color;
}

export function markLegend(marks: Pick<Mark, 'kind' | 'color'>[]): {color: string; labels: string[]}[] {
  const byColor = new Map<string, Set<string>>();
  for (const mark of marks) {
    const color = markColor(mark);
    if (!byColor.has(color)) byColor.set(color, new Set());
    byColor.get(color)!.add((markKinds[mark.kind] ?? markKinds.note).label);
  }
  return Array.from(byColor, ([color, labels]) => ({color, labels: Array.from(labels)}));
}
