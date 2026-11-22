import {markColor} from './project.ts';
import type {ArrowMark, Mark, PenMark, RegionMark, TextMark} from './project.ts';
import type {Point} from './geometry.ts';

export interface PenStyle {
  color: string;
  width: number;
  points: Point[];
}

export interface RegionStyle {
  color: string;
  width: number;
  center: Point;
  radii: Point;
  fill: number;
  dashed: boolean;
}

export interface ArrowStyle {
  color: string;
  width: number;
  points: Point[];
}

export interface TextStyle {
  color: string;
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
      return {color, width: selected ? 6 : 4, points: mark.points};
    case 'region': {
      const {a, b} = mark;
      return {color, width: selected ? 5 : 3, center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        radii: [Math.max(3, Math.abs(a[0] - b[0]) / 2), Math.max(3, Math.abs(a[1] - b[1]) / 2)],
        fill: selected ? .23 : .11, dashed: mark.source === 'ai'};
    }
    case 'arrow': {
      const {a, b} = mark;
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const length = Math.min(21, Math.hypot(b[0] - a[0], b[1] - a[1]) * .47);
      const tip = (offset: number): Point => [b[0] - length * Math.cos(angle + offset), b[1] - length * Math.sin(angle + offset)];
      return {color, width: selected ? 7 : 5, points: [a, b, tip(.55), b, tip(-.55)]};
    }
    case 'text':
      return {color};
  }
}

