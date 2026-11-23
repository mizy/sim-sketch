import type {ArrowMark, TextMark} from './project.ts';

/**
 * 箭头头部长度与文字字号的唯一真源。
 * 两者都是独立样式字段（8–96 整数），不随几何缩放、也不与线宽耦合。
 */
export const MIN_MARK_STYLE_SIZE = 8;
export const MAX_MARK_STYLE_SIZE = 96;
export const DEFAULT_ARROW_SIZE = 21;
export const DEFAULT_TEXT_FONT_SIZE = 22;

/** 旧箭头没有 size 时锁定升级前的头部公式观感。 */
const LEGACY_ARROW_HEAD_LIMIT = 21;
const LEGACY_ARROW_HEAD_RATIO = .47;
const LEGACY_ARROW_WIDTH_FACTOR = 1.8;

/**
 * 外部输入 → 合法样式尺寸。非数字返回 null（由调用方决定保留旧观感还是写默认值），
 * 有限数字按 8–96 夹取并取整，保证画布、导出和草稿使用同一口径。
 */
export function clampMarkStyleSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(MAX_MARK_STYLE_SIZE, Math.max(MIN_MARK_STYLE_SIZE, Math.round(value)));
}

export function normalizeArrowSize(value: unknown): number {
  return clampMarkStyleSize(value) ?? DEFAULT_ARROW_SIZE;
}

export function normalizeTextFontSize(value: unknown): number {
  return clampMarkStyleSize(value) ?? DEFAULT_TEXT_FONT_SIZE;
}

/** 显式 size 用自身值；旧箭头缺字段时继续走旧公式，观感不变。 */
export function arrowHeadLength(mark: Pick<ArrowMark, 'size'>, distance: number, lineWidth: number): number {
  const rodLength = Number.isFinite(distance) ? Math.max(0, distance) : 0;
  const limit = rodLength * .5;
  if (mark.size === undefined) {
    return Math.min(limit, Math.max(
      Math.min(LEGACY_ARROW_HEAD_LIMIT, rodLength * LEGACY_ARROW_HEAD_RATIO),
      Math.max(0, lineWidth) * LEGACY_ARROW_WIDTH_FACTOR));
  }
  return Math.min(limit, normalizeArrowSize(mark.size));
}

/** 旧文字没有 fontSize 时按 22 渲染；非法值同样回退 22。 */
export function textMarkFontSize(mark: Pick<TextMark, 'fontSize'>): number {
  return normalizeTextFontSize(mark.fontSize);
}
