import type {Point} from './geometry.ts';
import {textMarkFontSize} from './mark-style.ts';
import type {TextMark} from './project.ts';

/**
 * 画布文字的唯一度量来源：渲染、命中框、变换包围盒与全图适配全部从这里取。
 * 22px 是旧草稿的默认字号；显式 fontSize 按同一比例缩放字符宽高与 padding。
 */
export const TEXT_LABEL_FONT_SIZE = 22;
export const TEXT_LABEL_HEIGHT = 29;
export const TEXT_LABEL_PADDING = 3;
/** 圈选/箭头旁的标签片沿用历史字号与字符宽度，同样从这里取，避免第三套常量。 */
export const TEXT_CHIP_FONT_SIZE = 22;
export const TEXT_CHIP_ASCII_WIDTH = 13;
export const TEXT_CHIP_WIDE_WIDTH = 24;
export const TEXT_CHIP_MIN_PADDING = 22;
const ASCII_WIDTH = 13;
const WIDE_WIDTH = 22;
/** 空文字的可见命中宽度（不含两侧 padding），保证仍能点选与编辑。 */
const EMPTY_LABEL_WIDTH = 12;

export interface TextLabelBox {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  font: number;
}

/** 字号只改文字样式，不改变锚点与数值语义。 */
export function textFontSize(mark: TextMark): number {
  return textMarkFontSize(mark);
}

/** 文字标注的标签框；value/unit 与 label 拼成同一段可见文本。 */
export function textLabelBox(mark: TextMark): TextLabelBox {
  const value = mark.value === null ? '' : ` ${mark.value} ${mark.unit}`;
  const label = (mark.label + value).trim();
  const font = textFontSize(mark);
  const scale = font / TEXT_LABEL_FONT_SIZE;
  const padding = TEXT_LABEL_PADDING * scale;
  const width = label
    ? Array.from(label).reduce((sum, char) =>
      sum + ((char.codePointAt(0) ?? 0) > 255 ? WIDE_WIDTH : ASCII_WIDTH) * scale, 0)
    : EMPTY_LABEL_WIDTH * scale;
  return {
    label,
    x: mark.a[0] - padding,
    y: mark.a[1] - padding,
    width: width + padding * 2,
    height: TEXT_LABEL_HEIGHT * scale,
    font
  };
}

/** 四角顺序与矩形命中共用，供变换选框与视口适配直接消费。 */
export function textLabelCorners(mark: TextMark): Point[] {
  const box = textLabelBox(mark);
  return [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height]
  ];
}
