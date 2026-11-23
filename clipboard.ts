import {translatedMark} from './annotations.ts';
import {sanitizeBezierPath} from './bezier.ts';
import {arcCircle, boundedCoordinate, expandDegenerateBox, MAX_COORDINATE, MAX_PROJECT_OBJECTS,
  MAX_PROJECT_VERTICES, MIN_REGION_EXTENT, MIN_RECT_EXTENT, sketchInk, translateShape} from './geometry.ts';
import type {Point, Polygon, Shape} from './geometry.ts';
import {LEGACY_SHAPE_WIDTH} from './mark-width.ts';
import {clampMarkStyleSize} from './mark-style.ts';
import {projectWithinLimits} from './project.ts';
import type {Mark, MarkKind, MarkSource, Project} from './project.ts';

/** 复制内容带显式格式标记：只有本应用的 payload 才进入画布，普通文字粘贴不受影响。 */
export const CLIPBOARD_FORMAT = 'sim-sketch/clipboard';
export const CLIPBOARD_VERSION = 1;

/** 连续粘贴的固定步长（模型单位）；第 N 次粘贴偏移 N × 16。 */
export const PASTE_OFFSET = 16;

export interface ClipboardContent {
  shapes: Shape[];
  marks: Mark[];
  /** 系统剪贴板写入时的单调时间戳；用于识别“外部剪贴板比内存副本旧”。 */
  copiedAt?: number;
  /** 每次复制的唯一标识，避免同一毫秒内连续复制无法区分。 */
  nonce?: string;
  /** 产生该副本的标签页/编辑器会话；copiedAt 只在同一会话内比较。 */
  sessionId?: string;
}

export interface PasteOptions {
  dx: number;
  dy: number;
  /** 产品口径：粘贴一律落到当前活动图层，payload 源图层 id 全部映射到它。 */
  targetLayerId: string;
}

const SHAPE_TYPES = new Set(['line', 'rect', 'circle', 'arc', 'path']);
const MARK_SHAPES = new Set(['pen', 'region', 'arrow', 'text']);
const MARK_KINDS = new Set<MarkKind>(['fixed', 'force', 'pressure', 'structure', 'note', 'other']);
const MARK_SOURCES = new Set<MarkSource>(['manual', 'ai']);
/** 超过 8MB 的 text/plain 不可能是正常草图；先拒绝，避免 JSON.parse 同步冻结主线程。 */
const MAX_CLIPBOARD_TEXT = 8_000_000;
const MAX_CLIPBOARD_STRING = 2_000;
/** 外部时间戳只接受“本机时钟附近”的安全整数，避免 1e308/MAX_SAFE_INTEGER 污染去重水位。 */
const CLIPBOARD_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

type Raw = Record<string, unknown>;

/**
 * @entry 复制当前选择：只挑出画布上的图形与单个标注，深拷贝后与项目状态解耦。
 * 返回 null 表示没有可复制内容，快捷键不应拦截原生行为。
 */
export function clipboardContent(project: Project, shapeIds: readonly string[],
  markId: string | null): ClipboardContent | null {
  const selected = new Set(shapeIds);
  const shapes = project.shapes.filter(shape => selected.has(shape.id))
    .map(sanitizeShape).filter((shape): shape is Shape => shape !== null);
  const mark = markId ? project.marks.find(item => item.id === markId) : undefined;
  const marks = mark ? [sanitizeMark(mark)].filter((item): item is Mark => item !== null) : [];
  if (!shapes.length && !marks.length) return null;
  return projectWithinLimits({shapes, marks}) ? {shapes, marks} : null;
}

/** 写入系统剪贴板的文本格式；内存副本始终存在，写入失败不影响本轮粘贴。 */
export function serializeClipboard(content: ClipboardContent): string {
  return JSON.stringify({format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION,
    copiedAt: content.copiedAt, nonce: content.nonce, sessionId: content.sessionId,
    shapes: content.shapes, marks: content.marks});
}

/** 明显指向本应用但解析失败的文本，用于给出“不是 SimSketch 对象”提示。 */
export function looksLikeSimSketchClipboard(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.length <= MAX_CLIPBOARD_TEXT &&
    text.trimStart().startsWith('{') && text.includes(CLIPBOARD_FORMAT);
}

/** 只接受本应用的合法 payload；普通文本、损坏 JSON、旧版本一律忽略。 */
export function parseClipboard(text: string | null | undefined,
  now = Date.now()): ClipboardContent | null {
  if (!text || text.length > MAX_CLIPBOARD_TEXT) return null;
  try {
    const data: unknown = JSON.parse(text);
    if (!isRecord(data) || data.format !== CLIPBOARD_FORMAT || data.version !== CLIPBOARD_VERSION) return null;
    const rawShapes = Array.isArray(data.shapes) ? data.shapes : [];
    const rawMarks = Array.isArray(data.marks) ? data.marks : [];
    // 先按原始规模拒绝，超长数组不进入逐点 map。
    if (rawShapes.length + rawMarks.length > MAX_PROJECT_OBJECTS) return null;
    const shapes = rawShapes.map(sanitizeShape).filter((shape): shape is Shape => shape !== null);
    const marks = rawMarks.map(sanitizeMark).filter((mark): mark is Mark => mark !== null);
    if (!shapes.length && !marks.length) return null;
    const copiedAt = clipboardStamp(data.copiedAt, now);
    const nonce = boundedId(data.nonce);
    const sessionId = boundedId(data.sessionId);
    const content: ClipboardContent = {shapes, marks,
      ...(copiedAt === null ? {} : {copiedAt}), ...(nonce ? {nonce} : {}),
      ...(sessionId ? {sessionId} : {})};
    return projectWithinLimits(content) ? content : null;
  } catch {
    return null;
  }
}

/**
 * 生成粘贴结果：新 ID、固定偏移、保留类型/颜色/线宽/旋转等属性。
 * 所有对象统一落到 targetLayerId，不保留源图层（跨图层粘贴按当前活动图层落层）。
 */
export function pasteClipboard(content: ClipboardContent, options: PasteOptions): ClipboardContent {
  if (!Number.isFinite(options.dx) || !Number.isFinite(options.dy) ||
    !options.targetLayerId) return {shapes: [], marks: []};
  const shapes: Shape[] = [];
  for (const shape of content.shapes) {
    // 平移后的坐标也必须再次过安全边界，避免极端偏移把合法内容推出可渲染范围。
    const translated = sanitizeShape(translateShape(shape, options.dx, options.dy));
    if (translated) shapes.push({...translated, id: crypto.randomUUID(), layerId: options.targetLayerId});
  }
  const marks: Mark[] = [];
  for (const mark of content.marks) {
    const translated = sanitizeMark(translatedMark(mark, options.dx, options.dy));
    if (translated) marks.push({...translated, id: crypto.randomUUID(), layerId: options.targetLayerId});
  }
  const pasted: ClipboardContent = {shapes, marks};
  return projectWithinLimits(pasted) ? pasted : {shapes: [], marks: []};
}

let clipboardWrite: Promise<void> = Promise.resolve();

/**
 * 系统剪贴板是增强路径：权限被拒、非安全上下文或 API 缺失都降级到内存副本。
 * 写入串行化，避免连续复制 A/B 时后一次写先完成、系统剪贴板反而留下旧 A。
 * 返回是否真正写入系统剪贴板，供 UI 给一次明确提示。
 */
export function writeClipboardText(text: string): Promise<boolean> {
  // 非安全上下文/旧浏览器没有 Clipboard API：可选链会让 write 解析为 undefined，
  // 若不再显式检查就会误报“已写入系统剪贴板”，跨标签页粘贴静默失败。
  const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') return Promise.resolve(false);
  const write = clipboardWrite.then(() => clipboard.writeText(text));
  clipboardWrite = write.then(() => undefined, () => undefined);
  return write.then(() => true, () => false);
}

function sanitizeShape(value: unknown): Shape | null {
  if (!isRecord(value) || !SHAPE_TYPES.has(String(value.type))) return null;
  const base = {
    id: typeof value.id === 'string' ? value.id : '',
    type: value.type as Shape['type'],
    layerId: typeof value.layerId === 'string' ? value.layerId : '',
    // 外部 payload 的颜色会直接进入 SVG stroke/fill；只接受 #rrggbb，拒绝 url(...) 等 paint server。
    color: hexColor(value.color) ?? sketchInk,
    strokeWidth: typeof value.strokeWidth === 'number' && Number.isFinite(value.strokeWidth) && value.strokeWidth > 0
      ? value.strokeWidth : LEGACY_SHAPE_WIDTH
  };
  switch (value.type) {
    case 'line': {
      const points = pointList(value.points, 2);
      return points ? {...base, type: 'line', points} : null;
    }
    case 'arc': {
      const points = pointList(value.points, 3);
      // 三点共线/重合的圆弧没有可编辑圆心，渲染、命中与缩放都会退化成直线。
      return points && arcCircle(points) ? {...base, type: 'arc', points} : null;
    }
    case 'rect': {
      const a = point(value.a);
      const b = point(value.b);
      if (!a || !b) return null;
      const box = expandDegenerateBox(a, b, MIN_RECT_EXTENT, MIN_RECT_EXTENT);
      const rotation = finiteNumber(value.rotation);
      return {...base, type: 'rect', a: box.a, b: box.b, ...(rotation === null ? {} : {rotation})};
    }
    case 'circle': {
      const center = point(value.center);
      const radius = finiteNumber(value.radius);
      return center && radius !== null && radius >= 0 && radius <= MAX_COORDINATE
        ? {...base, type: 'circle', center, radius} : null;
    }
    case 'path': {
      const polygons = polygonList(value.polygons);
      if (!polygons) return null;
      const origin = point(value.origin);
      return {...base, type: 'path', polygons, ...(origin ? {origin} : {})};
    }
    default:
      return null;
  }
}

function sanitizeMark(value: unknown): Mark | null {
  if (!isRecord(value) || !MARK_SHAPES.has(String(value.shape))) return null;
  const kind = MARK_KINDS.has(value.kind as MarkKind) ? value.kind as MarkKind : 'note';
  const color = hexColor(value.color);
  const base = {
    id: typeof value.id === 'string' ? value.id : '',
    kind,
    label: boundedString(value.label),
    value: typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : null,
    unit: boundedString(value.unit),
    direction: boundedString(value.direction),
    question: boundedString(value.question),
    confirmed: value.confirmed === true,
    source: MARK_SOURCES.has(value.source as MarkSource) ? value.source as MarkSource : 'manual',
    layerId: typeof value.layerId === 'string' ? value.layerId : '',
    ...(color ? {color} : {})
  };
  const width = finiteNumber(value.width);
  const size = clampMarkStyleSize(value.size);
  const fontSize = clampMarkStyleSize(value.fontSize);
  switch (value.shape) {
    case 'pen': {
      // 画笔是自由轨迹：只丢弃非法采样点，保留其余连续笔迹。
      const points = penPointList(value.points);
      if (!points) return null;
      // 外部曲线严格拒绝越界控制点；损坏时回退 points，不丢整条笔迹。
      const curve = sanitizeBezierPath(value.curve, point);
      return {...base, shape: 'pen', points, ...(curve ? {curve} : {}),
        ...(width === null ? {} : {width})};
    }
    case 'region': {
      const a = point(value.a);
      const b = point(value.b);
      if (!a || !b) return null;
      const box = expandDegenerateBox(a, b, MIN_REGION_EXTENT, MIN_REGION_EXTENT);
      const rotation = finiteNumber(value.rotation);
      return {...base, shape: 'region', a: box.a, b: box.b, ...(width === null ? {} : {width}),
        ...(rotation === null ? {} : {rotation})};
    }
    case 'arrow': {
      const a = point(value.a);
      const b = point(value.b);
      return a && b ? {...base, shape: 'arrow', a, b, ...(width === null ? {} : {width}),
        ...(size === null ? {} : {size})} : null;
    }
    case 'text': {
      const a = point(value.a);
      return a ? {...base, shape: 'text', a, ...(fontSize === null ? {} : {fontSize})} : null;
    }
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * copiedAt 只用于“旧系统 payload 不覆盖新内存副本”。恶意/异常时钟值会让
 * `lastClipboardStamp + 1` 在 IEEE-754 下饱和，因此只接受安全整数且位于合理时钟窗口内。
 * 非法值直接忽略字段，内容本身仍可粘贴。
 */
function clipboardStamp(value: unknown, now: number): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  if (value > now + CLIPBOARD_CLOCK_SKEW_MS) return undefined;
  return value;
}

function boundedString(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_CLIPBOARD_STRING) : '';
}

/** nonce/sessionId 只作为短标识参与比较，超长字符串不进入裁剪后的伪身份。 */
function boundedId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
}

function hexColor(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

/** 非有限或超过硬上限的坐标直接拒绝，而不是夹取成“看似合法”的错误几何。 */
function point(value: unknown): Point | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = boundedCoordinate(value[0]);
  const y = boundedCoordinate(value[1]);
  return x !== null && y !== null && x === value[0] && y === value[1] ? [x, y] : null;
}

function pointList(value: unknown, minimum: number): Point[] | null {
  if (!Array.isArray(value) || value.length > MAX_PROJECT_VERTICES) return null;
  const points = value.map(point);
  if (points.length < minimum || points.some(item => item === null)) return null;
  return points as Point[];
}

function penPointList(value: unknown): Point[] | null {
  if (!Array.isArray(value) || value.length > MAX_PROJECT_VERTICES) return null;
  const points = value.map(point).filter((item): item is Point => item !== null);
  return points.length ? points : null;
}

function polygonList(value: unknown): Polygon[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const polygons: Polygon[] = [];
  let vertices = 0;
  for (const polygon of value) {
    if (!Array.isArray(polygon) || !polygon.length) return null;
    const rings: Point[][] = [];
    for (const ring of polygon) {
      const points = pointList(ring, 3);
      if (!points) return null;
      vertices += points.length;
      if (vertices > MAX_PROJECT_VERTICES) return null;
      rings.push(points);
    }
    polygons.push(rings);
  }
  return polygons;
}
