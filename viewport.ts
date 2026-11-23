import {arcPoints, boundedCoordinate, ellipseRing, MAX_COORDINATE, shapePoints} from './geometry.ts';
import type {Point, Shape} from './geometry.ts';
import type {Mark, Project} from './project.ts';
import type {RenderViewport} from './renderer.ts';
import {textLabelCorners} from './text-metrics.ts';
import {REGION_MIN_RADIUS} from './annotations.ts';

/** 交互缩放的硬边界；适配全图也会被夹到同一范围。 */
export const MIN_VIEW_ZOOM = 0.1;
export const MAX_VIEW_ZOOM = 8;
export const VIEW_BASE_WIDTH = 960;
export const VIEW_BASE_HEIGHT = 600;
const VIEW_BASE_CENTER: Point = [VIEW_BASE_WIDTH / 2, VIEW_BASE_HEIGHT / 2];
/** 适配视图时内容距边缘保留的世界单位；与旧 fitBoardView 一致。 */
const FIT_MARGIN = 24;
/** 视口中心与模型域共用 ±1e6 边界，保证指针落点永远不会被 boardPoint 夹到视口之外。 */
const MAX_VIEW_CENTER = MAX_COORDINATE;

export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CssSize {
  width: number;
  height: number;
}

export interface ScreenRect extends CssSize {
  left: number;
  top: number;
}

/**
 * @entry 画布临时视图：只保存 zoom/pan，不进入项目、不改变模型坐标。
 * 视口永远保持与画板 CSS 比例一致，因此三个渲染后端的 pixelsPerWorldUnit 都等于 zoom。
 */
export class BoardViewport {
  private zoomValue = 1;
  private centerValue: Point = [...VIEW_BASE_CENTER] as Point;
  /** 首帧尺寸未知时延后一次 fit；此后 resize 一律保留用户 zoom/center。 */
  private pendingFit = false;
  /** 首屏/新建是否把 960×600 基准画布一并纳入适配。 */
  private pendingFitBase = false;

  constructor(private readonly board: SVGSVGElement, private readonly project: () => Project) {}

  get zoom(): number {
    return this.zoomValue;
  }

  size(): CssSize {
    const rect = this.board.getBoundingClientRect();
    return {
      width: rect.width || this.board.clientWidth || VIEW_BASE_WIDTH,
      height: rect.height || this.board.clientHeight || VIEW_BASE_HEIGHT
    };
  }

  screenRect(): ScreenRect {
    const rect = this.board.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width || this.board.clientWidth || VIEW_BASE_WIDTH,
      height: rect.height || this.board.clientHeight || VIEW_BASE_HEIGHT
    };
  }

  /** 当前 viewBox 对应的世界矩形。 */
  view(): WorldRect {
    const {width, height} = this.size();
    return viewRectFor(this.centerValue, this.zoomValue, width, height);
  }

  renderViewport(): RenderViewport {
    const {width, height} = this.size();
    const view = viewRectFor(this.centerValue, this.zoomValue, width, height);
    return {
      x: view.x, y: view.y, width: view.width, height: view.height,
      cssWidth: width, cssHeight: height,
      dpr: Math.min(devicePixelRatio || 1, 2),
      pixelsPerWorldUnit: this.zoomValue
    };
  }

  /** 将临时视图写回 SVG viewBox；所有 DOM 覆盖层与导出快照因此共享同一世界坐标。 */
  apply(): void {
    const view = this.view();
    // NaN viewBox 会让整块画布空白且刷新复现；任何非有限值都宁可保留上一帧。
    if (![view.x, view.y, view.width, view.height].every(Number.isFinite)) return;
    this.board.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
  }

  /**
   * F / 初次加载：按内容适配一次；后续 resize 不再重算用户视图。
   * includeBase 仅用于首屏/新建，保持示例草图与旧版一致的取景范围。
   */
  fitProject(project: Project = this.project(), includeBase = false): void {
    const rect = this.board.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      this.pendingFit = true;
      this.pendingFitBase = includeBase;
      return;
    }
    this.pendingFit = false;
    this.pendingFitBase = false;
    const {width, height} = this.size();
    const fitted = fitWorldRect(project, width, height, includeBase);
    // 适配优先保证内容完整；模型边界只约束后续 pan/zoom，避免在 ±1e6 边缘
    // 把内容整体推向视口一侧而裁掉外框。
    this.centerValue = [fitted.x + fitted.width / 2, fitted.y + fitted.height / 2];
    this.zoomValue = clampZoom(width / fitted.width);
    this.apply();
  }

  /** 0：回到 100%，保留当前视图中心。 */
  reset(): void {
    this.zoomValue = 1;
    this.apply();
  }

  /** 窗口尺寸变化保持当前 zoom 与中心；只有首帧尺寸未知时才补一次 fit。 */
  resize(): CssSize {
    const size = this.size();
    if (!size.width || !size.height) return size;
    if (this.pendingFit) this.fitProject(this.project(), this.pendingFitBase);
    else this.apply();
    return size;
  }

  /** 空格拖拽：指针向右移动时内容跟手，世界中心反向移动。 */
  panBy(clientDx: number, clientDy: number): boolean {
    if (!clientDx && !clientDy) return false;
    const {width, height} = this.size();
    this.centerValue = clampViewCenter([
      this.centerValue[0] - clientDx / this.zoomValue,
      this.centerValue[1] - clientDy / this.zoomValue
    ], width / this.zoomValue, height / this.zoomValue);
    this.apply();
    return true;
  }

  /** 滚轮/触控板：以指针下的世界点为锚点缩放。 */
  zoomAt(factor: number, clientX: number, clientY: number): boolean {
    if (!Number.isFinite(factor) || factor <= 0) return false;
    return this.zoomToAt(this.zoomValue * factor, clientX, clientY);
  }

  /** Safari 手势缩放携带的是相对起始比例的绝对值，因此单独暴露目标 zoom。 */
  zoomToAt(targetZoom: number, clientX: number, clientY: number): boolean {
    const next = clampZoom(targetZoom);
    if (Math.abs(next - this.zoomValue) < 1e-6) return false;
    const rect = this.screenRect();
    if (!rect.width || !rect.height) return false;
    const anchor = worldFromScreen(clientX, clientY, rect, this.view());
    this.centerValue = clampViewCenter(anchorCenter(anchor, (clientX - rect.left) / rect.width,
      (clientY - rect.top) / rect.height, next, rect.width, rect.height),
      rect.width / next, rect.height / next);
    this.zoomValue = next;
    this.apply();
    return true;
  }

  /** +/- 快捷键以画板中心为锚点，避免视图跳动。 */
  zoomBy(factor: number): boolean {
    const rect = this.screenRect();
    return this.zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  screenToWorld(clientX: number, clientY: number): Point {
    return worldFromScreen(clientX, clientY, this.screenRect(), this.view());
  }

  worldToScreen(point: Point): {x: number; y: number} {
    return screenFromWorld(point, this.screenRect(), this.view());
  }

}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(MAX_VIEW_ZOOM, Math.max(MIN_VIEW_ZOOM, zoom));
}

/** 屏幕 px → 世界单位的唯一换算入口；缩放相关常量都应经过这里。 */
export function worldPerPixel(zoom: number): number {
  return 1 / Math.max(Number.isFinite(zoom) && zoom > 0 ? zoom : 1, 1e-6);
}

export function screenConstant(px: number, zoom: number): number {
  return px * worldPerPixel(zoom);
}

/** 由中心 + zoom 得到 viewBox；宽高始终匹配画板 CSS 比例，避免 SVG letterbox。 */
export function viewRectFor(center: Point, zoom: number, cssWidth: number, cssHeight: number): WorldRect {
  const z = clampZoom(zoom);
  const width = Math.max(1, cssWidth || VIEW_BASE_WIDTH) / z;
  const height = Math.max(1, cssHeight || VIEW_BASE_HEIGHT) / z;
  return {x: center[0] - width / 2, y: center[1] - height / 2, width, height};
}

/**
 * F 与导出共用的内容适配矩形：只框内容包围盒（含 24 单位留白），并保持给定比例。
 * includeBase 仅供首屏/新建：把 960×600 基准画布一起纳入，避免示例标注被放大。
 * 显式 F/导出永远只框内容，因此 -5000 处的草图会就地适配，不会回到原点。
 */
export function fitWorldRect(project: Project, cssWidth: number, cssHeight: number,
  includeBase = false): WorldRect {
  const width = Math.max(1, cssWidth || VIEW_BASE_WIDTH);
  const height = Math.max(1, cssHeight || VIEW_BASE_HEIGHT);
  const aspect = width / height;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  // 损坏坐标/恶意 payload 可能包含 NaN 或 1e308；非有限点跳过，超大有限值夹到安全上限。
  forEachObjectPoint(project, point => {
    const x = boundedCoordinate(point[0]);
    const y = boundedCoordinate(point[1]);
    if (x === null || y === null) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return {x: 0, y: 0, width: VIEW_BASE_WIDTH, height: VIEW_BASE_HEIGHT};
  }
  if (includeBase) {
    // 首屏/新建纳入基准画布，保持示例取景范围与旧版一致。
    minX = Math.min(minX, 0);
    minY = Math.min(minY, 0);
    maxX = Math.max(maxX, VIEW_BASE_WIDTH);
    maxY = Math.max(maxY, VIEW_BASE_HEIGHT);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const contentWidth = maxX - minX + FIT_MARGIN * 2;
  const contentHeight = maxY - minY + FIT_MARGIN * 2;
  const viewWidth = Math.max(1, contentWidth, contentHeight * aspect);
  const viewHeight = Math.max(1, contentHeight, contentWidth / aspect);
  return {
    x: centerX - viewWidth / 2,
    y: centerY - viewHeight / 2,
    width: viewWidth,
    height: viewHeight
  };
}

/** 导出必须独立于实时视口：始终按基准 8:5 比例做内容适配。 */
export function exportViewBox(project: Project): string {
  const rect = fitWorldRect(project, VIEW_BASE_WIDTH, VIEW_BASE_HEIGHT);
  return `${rect.x} ${rect.y} ${rect.width} ${rect.height}`;
}

export function worldFromScreen(clientX: number, clientY: number, screen: ScreenRect, view: WorldRect): Point {
  if (!screen.width || !screen.height) return [clientX, clientY];
  return [
    view.x + (clientX - screen.left) * view.width / screen.width,
    view.y + (clientY - screen.top) * view.height / screen.height
  ];
}

export function screenFromWorld(point: Point, screen: ScreenRect, view: WorldRect): {x: number; y: number} {
  if (!view.width || !view.height) return {x: screen.left, y: screen.top};
  return {
    x: screen.left + (point[0] - view.x) * screen.width / view.width,
    y: screen.top + (point[1] - view.y) * screen.height / view.height
  };
}

/** 保持锚点世界坐标不动所需的新中心。 */
export function anchorCenter(anchor: Point, fractionX: number, fractionY: number, zoom: number,
  cssWidth: number, cssHeight: number): Point {
  const width = Math.max(1, cssWidth || VIEW_BASE_WIDTH) / zoom;
  const height = Math.max(1, cssHeight || VIEW_BASE_HEIGHT) / zoom;
  return [anchor[0] + (0.5 - fractionX) * width, anchor[1] + (0.5 - fractionY) * height];
}

/** 滚轮缩放曲线：像素级 delta 保持平滑，浏览器 pinch 的小 delta 适当放大。 */
export function wheelZoomFactor(deltaY: number, pinch = false): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const sensitivity = pinch && Math.abs(deltaY) < 40 ? 0.01 : 0.002;
  return Math.exp(-deltaY * sensitivity);
}

/** 屏幕事件 → 世界坐标；保留小数，避免 800% 下整数取整造成 8px 跳动。 */
export function boardPoint(board: SVGSVGElement, event: {clientX: number; clientY: number}): Point {
  const matrix = board.getScreenCTM();
  if (matrix) {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return boundedWorldPoint([point.x, point.y]);
  }
  return boundedWorldPoint(worldFromScreen(event.clientX, event.clientY, screenRectOf(board), viewBoxOf(board)));
}

/**
 * 交互输入的世界坐标边界：视口可以平移，但绘制/拖动不能生成超出几何硬上限的坐标。
 * 非有限值回退到基准画布中心，避免 NaN 进入模型。
 */
function boundedWorldPoint(point: Point): Point {
  return [boundedCoordinate(point[0]) ?? VIEW_BASE_CENTER[0],
    boundedCoordinate(point[1]) ?? VIEW_BASE_CENTER[1]];
}

/**
 * @entry 视口中心与模型域统一：保留视图半宽/半高，使整个可见矩形都落在 ±MAX_COORDINATE 内。
 * 这样平移到远处后，boardPoint 的钳制不会把新绘制点丢到视口之外。
 */
export function clampViewCenter(point: Point, viewWidth: number, viewHeight: number,
  limit = MAX_VIEW_CENTER): Point {
  const halfWidth = Math.max(0, Number.isFinite(viewWidth) ? viewWidth : 0) / 2;
  const halfHeight = Math.max(0, Number.isFinite(viewHeight) ? viewHeight : 0) / 2;
  const clamp = (value: number, half: number): number => {
    if (!Number.isFinite(value)) return 0;
    const bound = Math.max(0, limit - half);
    return Math.max(-bound, Math.min(bound, value));
  };
  return [clamp(point[0], halfWidth), clamp(point[1], halfHeight)];
}

export function boardToScreen(board: SVGSVGElement, point: Point): {x: number; y: number} {
  const matrix = board.getScreenCTM();
  if (matrix) {
    const screen = new DOMPoint(point[0], point[1]).matrixTransform(matrix);
    return {x: screen.x, y: screen.y};
  }
  return screenFromWorld(point, screenRectOf(board), viewBoxOf(board));
}

/** CSS 像素 / 世界单位；用于内联文字字号与屏幕恒定尺寸。 */
export function boardScreenScale(board: SVGSVGElement): number {
  const matrix = board.getScreenCTM();
  if (matrix) return Math.hypot(matrix.a, matrix.b) || 1;
  const rect = board.getBoundingClientRect();
  const view = viewBoxOf(board);
  return Math.min((rect.width || view.width) / view.width, (rect.height || view.height) / view.height) || 1;
}

/** 两个世界点在屏幕上的距离（CSS px），用于“点回起点闭合”等像素级命中。 */
export function boardScreenDistance(board: SVGSVGElement, a: Point, b: Point): number {
  const screenA = boardToScreen(board, a);
  const screenB = boardToScreen(board, b);
  return Math.hypot(screenA.x - screenB.x, screenA.y - screenB.y);
}

function screenRectOf(board: SVGSVGElement): ScreenRect {
  const rect = board.getBoundingClientRect();
  const view = viewBoxOf(board);
  return {
    left: rect.left, top: rect.top,
    width: rect.width || view.width, height: rect.height || view.height
  };
}

function viewBoxOf(board: SVGSVGElement): WorldRect {
  const view = board.viewBox.baseVal;
  return {
    x: view.x || 0, y: view.y || 0,
    width: Math.max(1, view.width || VIEW_BASE_WIDTH),
    height: Math.max(1, view.height || VIEW_BASE_HEIGHT)
  };
}

/** 逐个对象遍历顶点，避免为 20 万点的画笔额外建一份大数组。 */
function forEachObjectPoint(project: Project, visit: (point: Point) => void): void {
  for (const object of [...project.marks, ...project.shapes]) {
    for (const point of objectPoints(object)) visit(point);
  }
}

function objectPoints(object: Mark | Shape): Point[] {
  if ('shape' in object) {
    switch (object.shape) {
      case 'pen':
        return object.points ?? [];
      case 'region': {
        // 渲染半径有 REGION_MIN_RADIUS 下限；F/导出必须框住抬升后的可见椭圆，
        // 否则外部 1×1 圈选会显示 6×6、画幅却只取 1×1 而裁掉边缘。
        const center: Point = [(object.a[0] + object.b[0]) / 2, (object.a[1] + object.b[1]) / 2];
        const radii: Point = [Math.max(REGION_MIN_RADIUS, Math.abs(object.a[0] - object.b[0]) / 2),
          Math.max(REGION_MIN_RADIUS, Math.abs(object.a[1] - object.b[1]) / 2)];
        if (!object.rotation) {
          return [[center[0] - radii[0], center[1] - radii[1]],
            [center[0] + radii[0], center[1] + radii[1]]];
        }
        return ellipseRing(center, radii, object.rotation);
      }
      case 'arrow':
        return [object.a, object.b];
      case 'text':
        // 文字可见宽度同样属于内容；只取锚点会让标签右侧被 fit 裁掉。
        return textLabelCorners(object);
    }
  }
  return object.type === 'arc' ? arcPoints(object) : shapePoints(object);
}
