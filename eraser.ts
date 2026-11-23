import {markGeometry} from './annotations.ts';
import {markWidth} from './mark-width.ts';
import {arcPoints, ellipseRing, rectCorners} from './geometry.ts';
import type {Point, Shape} from './geometry.ts';
import type {Mark, Project} from './project.ts';
import {textLabelBox} from './text-metrics.ts';

/** 一次拖动内累计的擦除目标；只在 pointerup 时整体提交一次，因此一次拖动 = 一步 undo。 */
export interface EraseSession {
  shapes: Set<string>;
  marks: Set<string>;
}

export interface EraseHit {
  shapes: string[];
  marks: string[];
}

/** 连续擦除的采样步长取半径的一半，避免快速拖动时漏掉细笔画。 */
const ERASE_STEP_RATIO = 0.5;
const MAX_ERASE_SAMPLES = 4096;
const ELLIPSE_SAMPLES = 96;

export function createEraseSession(): EraseSession {
  return {shapes: new Set(), marks: new Set()};
}

export function eraseSessionEmpty(session: EraseSession): boolean {
  return session.shapes.size === 0 && session.marks.size === 0;
}

/**
 * @entry 整条笔画/标注擦除的命中入口：半径内命中任一对象就标记整条删除，
 * 不产生新的几何。返回是否新增了目标，调用方据此决定是否重绘/提交。
 */
export function eraseAt(project: Project, point: Point, radius: number, session: EraseSession): boolean {
  const hit = hitTargets(project, point, radius);
  let changed = false;
  for (const id of hit.shapes) {
    if (session.shapes.has(id)) continue;
    session.shapes.add(id);
    changed = true;
  }
  for (const id of hit.marks) {
    if (session.marks.has(id)) continue;
    session.marks.add(id);
    changed = true;
  }
  return changed;
}

/** 按住拖动：沿指针轨迹插值采样，快速移动也不会留下未擦除的空隙。 */
export function eraseAlong(project: Project, from: Point, to: Point, radius: number, session: EraseSession): boolean {
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const step = Math.max(0.5, Math.abs(radius) * ERASE_STEP_RATIO);
  const count = Math.min(MAX_ERASE_SAMPLES, Math.max(1, Math.ceil(distance / step)));
  let changed = false;
  for (let index = 0; index <= count; index++) {
    const ratio = index / count;
    changed = eraseAt(project, [from[0] + (to[0] - from[0]) * ratio,
      from[1] + (to[1] - from[1]) * ratio], radius, session) || changed;
  }
  return changed;
}

/** 无目标时返回 null，Editor 据此不写空 undo。 */
export function erasedProject(project: Project, session: EraseSession): Project | null {
  if (eraseSessionEmpty(session)) return null;
  return {...project,
    shapes: project.shapes.filter(shape => !session.shapes.has(shape.id)),
    marks: project.marks.filter(mark => !session.marks.has(mark.id))};
}

/** 橡皮擦命中测试：所有几何/标注类型共用同一世界半径。 */
export function hitTargets(project: Project, point: Point, radius: number): EraseHit {
  const hit: EraseHit = {shapes: [], marks: []};
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return hit;
  const reach = Math.max(0, Number.isFinite(radius) ? radius : 0);
  for (const shape of project.shapes) {
    if (hitsShape(shape, point, reach)) hit.shapes.push(shape.id);
  }
  for (const mark of project.marks) {
    if (hitsMark(mark, point, reach)) hit.marks.push(mark.id);
  }
  return hit;
}

function hitsMark(mark: Mark, point: Point, radius: number): boolean {
  switch (mark.shape) {
    case 'pen': {
      const width = markWidth(mark) / 2;
      return hitsPolyline(point, mark.points, false, radius + width);
    }
    case 'region': {
      const style = markGeometry(mark, false);
      const reach = radius + style.width / 2;
      // 圈选是填充区域：点在椭圆内也应整条擦除，不必精确压线。
      if (insideRotatedEllipse(point, style.center, style.radii, style.rotation)) return true;
      return hitsPolyline(point, ellipseRing(style.center, style.radii, style.rotation, ELLIPSE_SAMPLES),
        true, reach);
    }
    case 'arrow': {
      const style = markGeometry(mark, false);
      return hitsPolyline(point, style.points, false, radius + style.width / 2);
    }
    case 'text': {
      const box = textLabelBox(mark);
      return point[0] >= box.x - radius && point[0] <= box.x + box.width + radius &&
        point[1] >= box.y - radius && point[1] <= box.y + box.height + radius;
    }
  }
}

function hitsShape(shape: Shape, point: Point, radius: number): boolean {
  const reach = radius + Math.abs(shape.strokeWidth || 0) / 2;
  switch (shape.type) {
    case 'line':
      return hitsPolyline(point, shape.points, false, reach);
    case 'arc':
      return hitsPolyline(point, arcPoints(shape), false, reach);
    case 'rect':
      // 矩形/路径只按描边命中；擦内部不应误删整块图形。
      return hitsPolyline(point, rectCorners(shape), true, reach);
    case 'circle':
      return Math.abs(Math.hypot(point[0] - shape.center[0], point[1] - shape.center[1]) -
        Math.abs(shape.radius)) <= reach;
    case 'path':
      return shape.polygons.some(polygon => polygon.some(ring => hitsPolyline(point, ring, true, reach)));
  }
}

function hitsPolyline(point: Point, points: readonly Point[], closed: boolean, radius: number): boolean {
  if (!points.length) return false;
  if (points.length === 1) return Math.hypot(point[0] - points[0][0], point[1] - points[0][1]) <= radius;
  const last = closed ? points.length : points.length - 1;
  for (let index = 0; index < last; index++) {
    if (distanceToSegment(point, points[index], points[(index + 1) % points.length]) <= radius) return true;
  }
  return false;
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

function insideRotatedEllipse(point: Point, center: Point, radii: Point, rotationDegrees: number): boolean {
  const radians = rotationDegrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point[0] - center[0];
  const dy = point[1] - center[1];
  const x = dx * cos + dy * sin;
  const y = -dx * sin + dy * cos;
  const rx = Math.max(0.1, radii[0]);
  const ry = Math.max(0.1, radii[1]);
  return (x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1;
}
