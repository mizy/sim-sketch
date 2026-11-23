import {markColor} from './project.ts';
import type {ArrowMark, Mark, PenMark, RegionMark, TextMark} from './project.ts';
import type {Point} from './geometry.ts';
import {markWidth, renderMarkWidth} from './mark-width.ts';
import {arrowHeadLength, textMarkFontSize} from './mark-style.ts';
import {transformBezierPath} from './bezier.ts';
import type {BezierPath} from './bezier.ts';

export interface PenStyle {
  color: string;
  width: number;
  points: Point[];
  /** 拟合曲线只影响显示路径；points 仍用于命中与包围盒。 */
  curve?: BezierPath;
}

export interface RegionStyle {
  color: string;
  width: number;
  center: Point;
  radii: Point;
  /** 旋转椭圆的角度（度）；0 时仍走原生 ellipse，避免无谓的路径采样。 */
  rotation: number;
  fill: number;
  dashed: boolean;
}

export interface ArrowStyle {
  color: string;
  width: number;
  points: Point[];
}

/** 圈选椭圆的可见半径下限；渲染、命中、选择框与最小缩放共用。 */
export const REGION_MIN_RADIUS = 3;
// 必须与 geometry.MIN_REGION_EXTENT = REGION_MIN_RADIUS × 2 保持同步。

export interface TextStyle {
  color: string;
  /** 字号是文字独立样式；渲染、命中框与内联编辑共用。 */
  fontSize: number;
}

/** 纯几何平移：剪贴板与拖动共用，不依赖编辑器/视口。 */
export function translatedMark(mark: Mark, dx: number, dy: number): Mark {
  const move = (point: Point): Point => [point[0] + dx, point[1] + dy];
  switch (mark.shape) {
    case 'pen':
      return {...mark, points: mark.points.map(move),
        ...(mark.curve ? {curve: transformBezierPath(mark.curve, move)} : {})};
    case 'region':
    case 'arrow':
      return {...mark, a: move(mark.a), b: move(mark.b)};
    case 'text':
      return {...mark, a: move(mark.a)};
  }
}


export function markGeometry(mark: PenMark, selected: boolean): PenStyle;
export function markGeometry(mark: RegionMark, selected: boolean): RegionStyle;
export function markGeometry(mark: ArrowMark, selected: boolean): ArrowStyle;
export function markGeometry(mark: TextMark, selected: boolean): TextStyle;
export function markGeometry(mark: Mark, selected: boolean): PenStyle | RegionStyle | ArrowStyle | TextStyle;
export function markGeometry(mark: Mark, selected: boolean): PenStyle | RegionStyle | ArrowStyle | TextStyle {
  const color = markColor(mark);
  switch (mark.shape) {
    case 'pen':
      return {color, width: renderMarkWidth(mark, selected), points: mark.points,
        ...(mark.curve ? {curve: mark.curve} : {})};
    case 'region': {
      const {a, b} = mark;
      return {color, width: renderMarkWidth(mark, selected), center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        radii: [Math.max(REGION_MIN_RADIUS, Math.abs(a[0] - b[0]) / 2),
          Math.max(REGION_MIN_RADIUS, Math.abs(a[1] - b[1]) / 2)],
        rotation: mark.rotation ?? 0, fill: selected ? .23 : .11, dashed: mark.source === 'ai'};
    }
    case 'arrow': {
      const {a, b} = mark;
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const length = arrowHeadLength(mark, Math.hypot(b[0] - a[0], b[1] - a[1]), markWidth(mark));
      const tip = (offset: number): Point => [b[0] - length * Math.cos(angle + offset), b[1] - length * Math.sin(angle + offset)];
      return {color, width: renderMarkWidth(mark, selected), points: [a, b, tip(.55), b, tip(-.55)]};
    }
    case 'text':
      return {color, fontSize: textMarkFontSize(mark)};
  }
}

