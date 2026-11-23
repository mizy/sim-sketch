import type {ArrowMark, PenMark, RegionMark} from './project.ts';

/** 可带线宽的标注；文字不参与线宽。 */
export type WidthMark = PenMark | RegionMark | ArrowMark;
export type WidthMarkShape = WidthMark['shape'];

export const MIN_MARK_WIDTH = 1;
export const MAX_MARK_WIDTH = 24;

/** 旧草稿没有 width 时按形状回退，保持升级前的观感。 */
export const LEGACY_MARK_WIDTH: Record<WidthMarkShape, number> = {pen: 4, region: 3, arrow: 5};

/** 用户未调粗细时的画笔值；与迁移默认值共用同一来源，避免两份字面量漂移。 */
export const DEFAULT_BRUSH_WIDTH = LEGACY_MARK_WIDTH.pen;

/** 旧版几何图形的默认线宽；缺失或脏数据统一回退到该值。 */
export const LEGACY_SHAPE_WIDTH = 2.4;

/** 选中态只是渲染加粗，不写回标注数据。 */
export const SELECTED_WIDTH_BONUS = 2;

/**
 * 把外部输入收敛成可落盘的整数线宽。
 * 返回 null 表示缺失或非法（NaN/Infinity/非数字），由调用方决定回退值。
 */
export function clampMarkWidth(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(MAX_MARK_WIDTH, Math.max(MIN_MARK_WIDTH, Math.round(value)));
}

/** 缺失/非法用形状默认值，数值越界按 1–24 夹取。 */
export function normalizeMarkWidth(shape: WidthMarkShape, value: unknown): number {
  return clampMarkWidth(value) ?? LEGACY_MARK_WIDTH[shape];
}

/** 当前画笔粗细：非法值回退默认画笔，而不是借用某个形状的迁移默认值。 */
export function normalizeBrushWidth(value: unknown): number {
  return clampMarkWidth(value) ?? DEFAULT_BRUSH_WIDTH;
}

/**
 * 旧图形线宽允许保留 2.4 这类历史小数；只清除 NaN/Infinity/非数字/非正数。
 * 没有用 clampMarkWidth 是因为它会四舍五入，改写旧草稿的既有观感。
 */
export function normalizeShapeStrokeWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return LEGACY_SHAPE_WIDTH;
  return Math.min(MAX_MARK_WIDTH, Math.max(MIN_MARK_WIDTH, value));
}

/** 读取标注自身线宽；即使调用方没走 normalizeProject，渲染也不会被脏数据拖垮。 */
export function markWidth(mark: WidthMark): number {
  return normalizeMarkWidth(mark.shape, mark.width);
}

export function renderMarkWidth(mark: WidthMark, selected: boolean): number {
  return markWidth(mark) + (selected ? SELECTED_WIDTH_BONUS : 0);
}
